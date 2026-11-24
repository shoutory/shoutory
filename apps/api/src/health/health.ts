import { assertKeyIdsLoaded, KeyError, type KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { sealedKeyIds } from "@shoutory/db/startup";
import { isUnavailable, Refusal } from "../errors/refusal.js";
import { type App, defineRoute } from "../routes/define-route.js";
import { assertJobsHealthy } from "./jobs.js";
import { migrationStatus } from "./migrations.js";
import { assertPartitionRunway } from "./partitions.js";

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

function readiness(pool: AppPool, keys: KeyProvider): () => Promise<void> {
  let inFlight: Promise<void> | undefined;

  async function probe(): Promise<void> {
    if ((await migrationStatus(pool)).pending.length > 0) {
      throw new Refusal("service_unavailable", "a shipped migration is not applied", {
        details: { cause: "migrations_missing" },
      });
    }
    await assertKeysHeld(pool, keys);
    await assertPartitionRunway(pool);
    await assertJobsHealthy(pool);
  }

  // Concurrent probes share one in-flight promise, so a burst costs one round trip.
  return () => {
    inFlight ??= probe().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

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
