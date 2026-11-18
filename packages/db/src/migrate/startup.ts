import type { Pool } from "pg";
import { loadMigrations, migrationsDir } from "./runner.js";

const UNDEFINED_TABLE = "42P01";

export class MissingMigrationError extends Error {
  constructor(missing: string[]) {
    super(`required migrations are not applied: ${missing.join(", ")}; run the migrate command first`);
    this.name = "MissingMigrationError";
  }
}

/** The key ids that sealed rows still hold, read through the definer; the caller checks them against its key ring. */
export async function sealedKeyIds(pool: Pool): Promise<string[]> {
  const rows = (await pool.query("SELECT key_id FROM app.sealed_key_ids()")).rows as { key_id: string }[];
  return rows.map((row) => row.key_id);
}

/** Stops start-up when a shipped migration is not recorded as applied, so the app never runs on an old schema. */
export async function assertMigrationsApplied(pool: Pool, dir: string = migrationsDir): Promise<void> {
  const shipped = (await loadMigrations(dir)).map(({ name }) => name);
  let applied: Set<string>;
  try {
    const rows = (await pool.query("SELECT name FROM app.schema_migrations")).rows as { name: string }[];
    applied = new Set(rows.map((row) => row.name));
  } catch (error) {
    // A database that was never migrated has no record table: every shipped file is missing.
    if ((error as { code?: string }).code !== UNDEFINED_TABLE) throw error;
    applied = new Set();
  }
  const missing = shipped.filter((name) => !applied.has(name));
  if (missing.length > 0) throw new MissingMigrationError(missing);
}
