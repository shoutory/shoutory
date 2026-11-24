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

/** A comment-only revision of an applied file: accepted only when the stored sum is `from` and the file's is `to`. */
export interface AcceptedRevision {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/** Entries are added only for revisions that change comment lines; the SQL of an applied file never changes. */
export const ACCEPTED_REVISIONS: readonly AcceptedRevision[] = [
  {
    name: "0001_roles_and_schemas.sql",
    from: "8fdc9ede124c16e576b5f842b17a258f150ba837671e266fd8c3b5aacc675bba",
    to: "2a492d77b626d369d865a21e4a57aa6960a915896e2b08799b447d2daefcfd75",
  },
  {
    name: "0002_meta.sql",
    from: "a9425bfe45ec1d3fb17a5f9b341522631ed73eddb3536f196b20b551138fead2",
    to: "43dcc69be377511e41ca2aeb29a690fc8d438230961936711a1d4d45663999b4",
  },
  {
    name: "0003_app_helpers.sql",
    from: "eed6ba981123bc3688687e4e46afdaeec13789a3aad2f6243f1761b4fa49cb84",
    to: "8515699b666d330d7b97f95fa3ba13d5f5464b03a2b30bbe9948fad77d682a96",
  },
  {
    name: "0004_auth.sql",
    from: "9c50faca051e311544a54dc0570b46113344a6f9ef23e58d6a46d7b511ab2fc5",
    to: "acecdb80bfa61de506667f5fbe9437d5ec29a8f4067ef6b6f3717492d42438e2",
  },
  {
    name: "0005_step_up_and_throttle.sql",
    from: "ddc790d09242e8242d315d1e142eccde90ee6caf457f3d9a3dbd64a5eafddc40",
    to: "e51263b75ec11d1bf475e858938b64318600ee509873284af110dae21a4d3a6d",
  },
  {
    name: "0006_email_outbox.sql",
    from: "a03ef3c5d0b9c5934975fab87b47ee5e66f6ab25b2db74c7001b42e6606a9f32",
    to: "5514bf0c96c27140c9a9db167bd21ffc7f645cea1228f84eea0ad77619b0a3fa",
  },
  {
    name: "0007_tenancy.sql",
    from: "58521ba03d25f048e1f5cc47edbb2b3c5f257367b7c62a77e037080f66db3544",
    to: "9b62773dde0b90d531ea70766dc3f82d356dad45389c9fb93023c19cb13ebd43",
  },
  {
    name: "0008_audit.sql",
    from: "45631fe6c7775eae3770972358a82fddb18c233da34b4ba26796febed2790a20",
    to: "7cc65597d5dbdf43d170377046392a5f8b06a74d6a019604ee586424d5b5f91b",
  },
  {
    name: "0009_access_definers.sql",
    from: "4ab0d8d2fbe34916216a74b3f2fe8e31317c48cdab060c18664ebf4303fa3b46",
    to: "5841582d2d1c4e422703a174e5224c27ad3892b74ff24cd23509d40db273536b",
  },
  {
    name: "0010_invitations.sql",
    from: "8a1915da54d1dc4dd23bd148dc9a248231c40cba44463dcbd5ed3c80d882573d",
    to: "ffbee445851e9e9faf6665d110a5403e2505e6e8a33d48749da7be663a71d9d7",
  },
  {
    name: "0011_flags.sql",
    from: "575843ce5b73720f28364cc8cdae82df1189031827ca0faad84d6a2e04f38977",
    to: "11438a1857ce58e9acdc2a6a11b4397709db62f4caf06270db87726dcfc86ab5",
  },
  {
    name: "0012_outbox.sql",
    from: "67e2baba20da415144f83b788cdab5706b45050b7a526fc1209fa97eb7d31c14",
    to: "a1f720fb8156a82b87f0c9f13f3587b3f281d8e0a9642f12c6f7e53b3d12b3e7",
  },
  {
    name: "0013_channels.sql",
    from: "e03d43637c322c1f44d075622a1eea50a5c2c03f7190011fcde2f4811804322c",
    to: "5f6399c3999bbb26cb7350334f64ae322178ed567f96d5f53590eef38b7f1c32",
  },
  {
    name: "0014_credentials.sql",
    from: "f45c10d2ab24cf4c578ccc0ff65e674c19eb5902a65a56afe0ccc24b2b42cc68",
    to: "f8a0975c2c84c276dd5d4551cba6c6d3ea5bde9ac52559c23c57ef4a35cfde98",
  },
  {
    name: "0015_connect.sql",
    from: "510c86d6411019815b6fdb2c3abea0d838d625e8bfab55d939e38ee619fbb714",
    to: "1cda0e7b194bff67fff05a87679bb7919449dead2fb4bd81e88d1e3d2c1c7873",
  },
  {
    name: "0016_media.sql",
    from: "03ae0cd49055c28de6b347e854f3da86c564a950686fd5ece08ff7c4145f5aa9",
    to: "9ee8fd13c533a33252167dfe2a155f323d4de1bb89db82fbc17ec7d15ed28772",
  },
  {
    name: "0017_connect_guard.sql",
    from: "26122508641dd20832150248fb36ed4f980dcc62ccdbdaf766657c18b7d7876b",
    to: "485ef2f5ccf5bc2f0b7e9ec55d854da60b99d6fdb22ef4c567c697b29577dac1",
  },
  {
    name: "0018_content.sql",
    from: "7fb2f6ed3fe99ded90c3bc670d0187afb3eb8bc20f2891ca12bd76362e513ba4",
    to: "2df8169b54098729e55500a8ac644dd0afbc2add7e25d37a216e4f6bbee44e9d",
  },
  {
    name: "0019_ledger.sql",
    from: "87b6e41a623a96b153750331ae4cb77ec2424267cb16e3a8a88513749005e060",
    to: "7111a7ed1c3c114936db40ab585b7a1d9fcfb3e3d6ab620688ebf56d8fa036a9",
  },
  {
    name: "0020_ledger_definers.sql",
    from: "c4146285a8a2a02e93e6eec6d6b2266eef9c8124dcea2eab31b1de676708c8fb",
    to: "42f49a50276e197b2e47bd1e3430f9994d074ac246c1f74e96419c84a102f222",
  },
  {
    name: "0021_ledger_runtime.sql",
    from: "024bcd4c51b3ce96ab29f4d4038459054d4f100c67f68e2b73c8d891e396fa8f",
    to: "5c70e3381f582a7c6ab0e25422a9cf360852068b31b1cdd3ef5d90f4f7eb4235",
  },
  {
    name: "0022_resolutions.sql",
    from: "1975a8f981ab337f7c39bd45cb2ea700ad6a4a125bf74190807f9e39870e43ad",
    to: "51dcbe4628c0c8717c8fe6cdfcfee8cdaef90d838108ad468df12904bfbd731d",
  },
  {
    name: "0023_media_gating.sql",
    from: "3fffeef2c1aa96230e4203f6eaa1b293289717b2138d01837a4c3bb187dc3525",
    to: "fbce6153a20d1f6a36490af378c05bed3a0f489d22f64373ae1ae9637fd4e56a",
  },
  {
    name: "0024_media_multipart.sql",
    from: "594758a85302e502a238fa1d44c6a91419c37fb701d5a65355a23578f2903dc7",
    to: "153b994ea031433734de4e7d5701baca15ac01393722e3a646bfc05dee41f8d6",
  },
  {
    name: "0025_media_gc.sql",
    from: "59ff7795ab50c9568de5517bf24dcd0c5d7cf9608c0a807b93b50909010a6e98",
    to: "bb111329221a17d9b527564b244b30dd10849f88fe54d03e20358aa2c20f25b3",
  },
  {
    name: "0026_operation_media.sql",
    from: "29e406f1781dd309ebbf8c5d9894155b2d18048149c3a22a658d91537bde8695",
    to: "c96cdf56764f81f4b387df943a2b9a43be3962ea4849d89158f79e460629993c",
  },
  {
    name: "0027_instance_apps.sql",
    from: "c22a3c9032ab5b2dc9f148fbf5105153befc1606ad014c88bc2c7cb4fb4d5edc",
    to: "255da9189b1db416d782e6267cc19325ef0076981ad5bdbcd0adfbc40ea72faf",
  },
  {
    name: "0028_ledger_reasons.sql",
    from: "e78d53d306e55421814d409c98f5ce2aad332bc9c014f172ec7099a3fc61cee4",
    to: "bdb9cb9fb73ab42c5699eb6225bab5793a31a14daa2b1b5805896e467a8a1b3d",
  },
  {
    name: "0029_ledger_reasons_validate.sql",
    from: "cbcc0cb3c6261ca162d56cc6e8aaecb81eb09161b6df6375fc107d807ebdec51",
    to: "8cdd6d5c70610db8870b843879a1facae045ca7ebd07ec609b7c924abc95c7a8",
  },
];

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

// Numbers run 0001, 0002, ... with no gap and no repeat; any other .sql name is refused, not skipped.
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

// The accepted revisions are checked before any is stored, so one refused file leaves every record as it was.
async function recordRevisions(client: PoolClient, revised: Migration[]): Promise<void> {
  if (revised.length === 0) return;
  await client.query("BEGIN");
  try {
    for (const { name, checksum } of revised) {
      await client.query("UPDATE app.schema_migrations SET checksum = $2 WHERE name = $1", [name, checksum]);
    }
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
  accepted: readonly AcceptedRevision[],
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
  const revised: Migration[] = [];
  for (const migration of migrations) {
    const recorded = applied.get(migration.name);
    if (recorded === undefined || recorded === migration.checksum) continue;
    const listed = accepted.some(
      ({ name, from, to }) => name === migration.name && from === recorded && to === migration.checksum,
    );
    if (!listed) throw new MigrationChecksumError(migration.name);
    revised.push(migration);
  }
  await recordRevisions(client, revised);
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
  accepted: readonly AcceptedRevision[] = ACCEPTED_REVISIONS,
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
      applyPending(client, migrations, limits.fileLockTimeoutMs ?? FILE_LOCK_TIMEOUT_MS, accepted),
    );
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw new MigrationLockTimeoutError();
    throw error;
  } finally {
    await pool.end();
  }
}
