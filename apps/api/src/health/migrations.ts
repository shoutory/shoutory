import { loadMigrations } from "@shoutory/db/migrate";
import type { AppPool } from "@shoutory/db/pool";
import { isUnavailable, Refusal } from "../errors/refusal.js";

const UNDEFINED_TABLE = "42P01";

export interface MigrationStatus {
  readonly applied: number;
  readonly shipped: number;
  readonly pending: string[];
}

let shipped: Promise<string[]> | undefined;

// Read once; a failed read is not remembered.
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

export async function migrationStatus(pool: AppPool): Promise<MigrationStatus> {
  const names = await shippedNames();
  const applied = await appliedNames(pool);
  const pending = names.filter((name) => !applied.has(name));
  return { applied: names.length - pending.length, shipped: names.length, pending };
}
