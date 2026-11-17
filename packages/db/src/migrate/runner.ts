import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { withAdvisoryLock } from "../locks.js";
import { lintMigration, NO_TRANSACTION_MARKER } from "./lint.js";

export const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface Migration {
  name: string;
  sql: string;
  /** SHA-256 of the file bytes; an applied file that no longer matches is never run again. */
  checksum: string;
  /** The first line is the marker: the file runs alone, outside a transaction (for CONCURRENTLY). */
  noTransaction: boolean;
}

export class MigrationChecksumError extends Error {
  constructor(name: string) {
    super(`migration ${name} was applied with different content; an applied file is never edited`);
    this.name = "MigrationChecksumError";
  }
}

export class MigrationLintError extends Error {
  constructor(findings: string[]) {
    super(`unsafe statements, nothing was applied:\n${findings.join("\n")}`);
    this.name = "MigrationLintError";
  }
}

export class MigrationFolderError extends Error {
  constructor(problem: string) {
    super(`the migrations folder is not valid, nothing was applied: ${problem}`);
    this.name = "MigrationFolderError";
  }
}

export class MigrationInvalidIndexError extends Error {
  constructor(indexes: string[]) {
    super(
      `invalid indexes left by a failed concurrent build: ${indexes.join(", ")}; drop them and run again`,
    );
    this.name = "MigrationInvalidIndexError";
  }
}

export class MigrationLockTimeoutError extends Error {
  constructor() {
    super("a lock was not available in time, so the run stopped; nothing past the last recorded file ran");
    this.name = "MigrationLockTimeoutError";
  }
}

/** Waits for the migrate lock (default 15 minutes) and for each file's table locks (default 5 seconds). */
export interface MigrateLimits {
  lockWaitMs?: number;
  fileLockTimeoutMs?: number;
}

const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const CONNECT_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 15 * 60_000;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const LOCK_NOT_AVAILABLE = "55P03";

// Numbers run 0001, 0002, ... with no gap and no repeat (AGENTS 8.2); any other .sql name is refused, not skipped.
function assertFolderNames(names: string[]): void {
  const odd = names.filter((name) => !FILE_NAME.test(name));
  if (odd.length > 0) throw new MigrationFolderError(`unexpected file name ${odd.join(", ")}`);
  names.forEach((name, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (name.slice(0, 4) !== expected) {
      throw new MigrationFolderError(`expected number ${expected} at position ${index + 1}, found ${name}`);
    }
  });
}

export async function loadMigrations(dir: string = migrationsDir): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  assertFolderNames(names);
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(`${dir}/${name}`);
      const sql = bytes.toString("utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        noTransaction: sql.split(/\r?\n/, 1)[0]?.trim() === NO_TRANSACTION_MARKER,
      };
    }),
  );
}

// A failed concurrent build leaves an invalid index, and "IF NOT EXISTS" skips it on the rerun, so a marked file
// is never recorded while any invalid index exists.
async function assertNoInvalidIndex(client: PoolClient): Promise<void> {
  const invalid = await client.query(
    "SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid",
  );
  if (invalid.rows.length > 0)
    throw new MigrationInvalidIndexError(invalid.rows.map((row) => row.name as string));
}

// A marked file is one statement run on its own, so it must be safe to run again if the process stops before the
// record is written; an unmarked file and its record commit together.
async function applyOne(client: PoolClient, migration: Migration): Promise<void> {
  const record = () =>
    client.query("INSERT INTO app.schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      migration.checksum,
    ]);
  if (migration.noTransaction) {
    await client.query(migration.sql);
    await assertNoInvalidIndex(client);
    await record();
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await record();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Runs under the migrate lock: the bootstrap and the read of what is applied must not race another runner.
async function applyPending(
  client: PoolClient,
  migrations: Migration[],
  fileLockTimeoutMs: number,
): Promise<string[]> {
  // The client is dedicated to this run and discarded with its pool, so the setting never reaches other work.
  await client.query(`SET lock_timeout = ${Math.trunc(fileLockTimeoutMs)}`);
  await client.query("CREATE SCHEMA IF NOT EXISTS app");
  await client.query(
    `CREATE TABLE IF NOT EXISTS app.schema_migrations (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const rows = (await client.query("SELECT name, checksum FROM app.schema_migrations")).rows as {
    name: string;
    checksum: string;
  }[];
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  for (const migration of migrations) {
    const recorded = applied.get(migration.name);
    if (recorded !== undefined && recorded !== migration.checksum) {
      throw new MigrationChecksumError(migration.name);
    }
  }
  const pending = migrations.filter((migration) => !applied.has(migration.name));
  const highest = [...applied.keys()].sort().at(-1) ?? "";
  const behind = pending.filter(({ name }) => name < highest);
  if (behind.length > 0) {
    throw new MigrationFolderError(
      `pending ${behind.map(({ name }) => name).join(", ")} is numbered below the applied ${highest}`,
    );
  }
  const unsafe = pending.flatMap(({ name, sql }) =>
    lintMigration(sql).map((found) => `${name}: ${found.rule}`),
  );
  if (unsafe.length > 0) throw new MigrationLintError(unsafe);
  for (const migration of pending) await applyOne(client, migration);
  return pending.map((migration) => migration.name);
}

/** Applies every pending file of `dir` as the connected role and returns the names it applied. */
export async function migrateDatabase(
  url: string,
  dir: string = migrationsDir,
  limits: MigrateLimits = {},
): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  // The pool-wide lock_timeout bounds the wait for the migrate lock; applyPending then sets the file limit.
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c lock_timeout=${Math.trunc(limits.lockWaitMs ?? LOCK_WAIT_MS)}`,
  });
  try {
    return await withAdvisoryLock(pool, "migrate", (client) =>
      applyPending(client, migrations, limits.fileLockTimeoutMs ?? FILE_LOCK_TIMEOUT_MS),
    );
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw new MigrationLockTimeoutError();
    throw error;
  } finally {
    await pool.end();
  }
}
