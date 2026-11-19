import { loadMigrations } from "@shoutory/db/migrate";
import type { AppPool } from "@shoutory/db/pool";
import { isUnavailable, Refusal } from "../errors/refusal.js";

const UNDEFINED_TABLE = "42P01";

/** The shipped migrations against the applied ones: how many of the shipped files are applied, and which are not. */
export interface MigrationStatus {
  readonly applied: number;
  readonly shipped: number;
  readonly pending: string[];
}

let shipped: Promise<string[]> | undefined;

/** The names of the migration files this build ships, read once; a failed read is not remembered. */
async function shippedNames(): Promise<string[]> {
  shipped ??= loadMigrations().then((all) => all.map(({ name }) => name));
  return shipped.catch((error: unknown) => {
    shipped = undefined;
    throw error;
  });
}

async function appliedNames(pool: AppPool): Promise<Set<string>> {
  try {
    const rows = (await pool.query("SELECT name FROM app.schema_migrations")).rows as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch (error) {
    if (isUnavailable(error)) {
      throw new Refusal("service_unavailable", "database unreachable", {
        cause: error,
        details: { cause: "database_unreachable" },
      });
    }
    // A database that was never migrated has no record table: every shipped file is missing.
    if ((error as { code?: string }).code !== UNDEFINED_TABLE) throw error;
    return new Set();
  }
}

/** The one comparison of applied and shipped migrations, for the readiness probe and the admin system answer. */
export async function migrationStatus(pool: AppPool): Promise<MigrationStatus> {
  const names = await shippedNames();
  const applied = await appliedNames(pool);
  const pending = names.filter((name) => !applied.has(name));
  return { applied: names.length - pending.length, shipped: names.length, pending };
}
