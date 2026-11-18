import { assertKeyIdsLoaded, KeyError, type KeyProvider } from "@shoutory/core/keys";
import { loadMigrations } from "@shoutory/db/migrate";
import type { AppPool } from "@shoutory/db/pool";
import { sealedKeyIds } from "@shoutory/db/startup";
import { isUnavailable, Refusal } from "../errors/refusal.js";
import { type App, defineRoute } from "../routes/define-route.js";
import { assertPartitionRunway } from "./partitions.js";

const UNDEFINED_TABLE = "42P01";

/** Every key id a sealed row holds must have a loaded key, or those rows could never be opened again. */
async function assertKeysHeld(pool: AppPool, keys: KeyProvider): Promise<void> {
  try {
    assertKeyIdsLoaded(await sealedKeyIds(pool), keys);
  } catch (error) {
    if (error instanceof KeyError) {
      throw new Refusal("service_unavailable", "a key id in use has no loaded key", {
        cause: error,
        details: { cause: "key_missing" },
      });
    }
    if (isUnavailable(error)) {
      throw new Refusal("service_unavailable", "database unreachable", {
        cause: error,
        details: { cause: "database_unreachable" },
      });
    }
    throw error;
  }
}

/**
 * The unauthenticated probe must stay cheap: the shipped names are read once and a probe is three queries (applied
 * migrations, held key ids, partition runway), each after the one before passed. Concurrent requests share one probe.
 */
function readiness(pool: AppPool, keys: KeyProvider): () => Promise<void> {
  let shipped: Promise<string[]> | undefined;
  let inFlight: Promise<void> | undefined;

  async function probe(): Promise<void> {
    shipped ??= loadMigrations().then((all) => all.map(({ name }) => name));
    // A failed read is not remembered: the next probe reads the folder again.
    const names = await shipped.catch((error: unknown) => {
      shipped = undefined;
      throw error;
    });
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
    await assertKeysHeld(pool, keys);
    await assertPartitionRunway(pool);
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
export function registerHealth(app: App, pool: AppPool, keys: KeyProvider): void {
  const ready = readiness(pool, keys);
  defineRoute(app, {
    method: "get",
    path: "/healthz",
    policy: "public",
    access: "none",
    handler: () => ({ status: "ok" }),
  });
  defineRoute(app, {
    method: "get",
    path: "/readyz",
    policy: "public",
    access: "none",
    handler: async () => {
      await ready();
      return { status: "ready" };
    },
  });
}
