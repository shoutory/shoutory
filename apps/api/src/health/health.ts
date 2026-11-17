import { loadMigrations } from "@shoutory/db/migrate";
import type { AppPool } from "@shoutory/db/pool";
import { isUnavailable, Refusal } from "../errors/refusal.js";
import { type App, defineRoute } from "../routes/define-route.js";

const UNDEFINED_TABLE = "42P01";

/** The unauthenticated probe must stay cheap: the shipped names are read once and each probe is one query. */
function readiness(pool: AppPool): () => Promise<void> {
  let shipped: Promise<string[]> | undefined;
  let inFlight: Promise<void> | undefined;

  async function probe(): Promise<void> {
    shipped ??= loadMigrations().then((all) => all.map(({ name }) => name));
    const names = await shipped;
    let applied = new Set<string>();
    try {
      const rows = (await pool.query("SELECT name FROM app.schema_migrations")).rows as { name: string }[];
      applied = new Set(rows.map((row) => row.name));
    } catch (error) {
      if (isUnavailable(error)) {
        throw new Refusal("service_unavailable", "database unreachable", {
          cause: error,
          details: { cause: "database_unreachable" },
        });
      }
      // A database that was never migrated has no record table: every shipped file is missing.
      if ((error as { code?: string }).code !== UNDEFINED_TABLE) throw error;
    }
    if (names.some((name) => !applied.has(name))) {
      throw new Refusal("service_unavailable", "a shipped migration is not applied", {
        details: { cause: "migrations_missing" },
      });
    }
  }

  // Concurrent probes share one in-flight promise, so a burst costs one round trip.
  return () => {
    inFlight ??= probe().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

/** `/healthz` says the process is up and touches nothing; `/readyz` says it can serve. */
export function registerHealth(app: App, pool: AppPool): void {
  const ready = readiness(pool);
  defineRoute(app, { method: "get", path: "/healthz", policy: "public", handler: () => ({ status: "ok" }) });
  defineRoute(app, {
    method: "get",
    path: "/readyz",
    policy: "public",
    handler: async () => {
      await ready();
      return { status: "ready" };
    },
  });
}
