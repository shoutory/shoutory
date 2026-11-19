import { randomUUID } from "node:crypto";
import { withSystem } from "@shoutory/db/context/system";
import { withAdvisoryLock } from "@shoutory/db/locks";
import type { AppPool } from "@shoutory/db/pool";
import type { PgBoss } from "pg-boss";
import type { Logger } from "../logging/logger.js";
import { createBoss } from "./boss.js";
import { createOutboxRelay } from "./outbox-relay.js";
import { JOB_QUEUES, PARTITION_CLASSES, parseJobPayload, RETENTION_CLASSES } from "./registry.js";

export interface WorkerOptions {
  readonly connectionString: string;
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly role: "worker" | "all";
  /** Beat and relay intervals; the defaults are the production values (30 s, 1 s). */
  readonly heartbeatMs?: number;
  readonly relayIntervalMs?: number;
}
export interface StartedWorker {
  close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;
const RELAY_INTERVAL_MS = 1_000;
const POLL_SECONDS = 30;
const STOP_TIMEOUT_MS = 10_000;
// A purge call removes at most this many rows; the job calls again while one comes back full (R309), and stops after
// MAX_PURGE_CALLS so one run cannot hold a connection for ever (AGENTS 6.6): the next night continues.
const PURGE_BATCH = 5_000;
const MAX_PURGE_CALLS = 1_000;

// One instance-wide key for every statement that takes ACCESS EXCLUSIVE on a partitioned parent (R308, R320).
const PARTITION_LOCK_KEY = "partitions";

type SystemTx = Parameters<Parameters<typeof withSystem>[2]>[0];
const underPartitionLock = <T>(pool: AppPool, run: (tx: SystemTx) => Promise<T>): Promise<T> =>
  withSystem(pool, "maintenance", (tx) =>
    withAdvisoryLock(tx, "maintenance", () => run(tx), PARTITION_LOCK_KEY),
  );

/** The scheduled upkeep: keeps the partitions three leaves ahead, one run at a time across workers (R308). */
export function ensurePartitions(pool: AppPool): Promise<number> {
  return underPartitionLock(
    pool,
    async (tx) =>
      (await tx.query<{ made: number }>("SELECT app.ensure_partitions() AS made")).rows[0]?.made ?? 0,
  );
}

/**
 * Purges one retention class, calling again while a call removes a full batch; answers the rows removed. A partition
 * class takes the same lock as `ensurePartitions`, so a purge never races it on one parent (R320).
 */
export async function purgeExpired(pool: AppPool, retentionClass: string, logger: Logger): Promise<number> {
  let total = 0;
  const partitioned = (PARTITION_CLASSES as readonly string[]).includes(retentionClass);
  const purge = (tx: SystemTx) =>
    tx.query<{ removed: string; skipped: string[] }>("SELECT removed, skipped FROM app.purge_expired($1)", [
      retentionClass,
    ]);
  for (let call = 0; call < MAX_PURGE_CALLS; call++) {
    const result = await (partitioned
      ? underPartitionLock(pool, purge)
      : withSystem(pool, "maintenance", purge));
    const row = result.rows[0];
    const removed = Number(row?.removed ?? 0);
    total += removed;
    if (row?.skipped.length) {
      logger.warn(
        { class: retentionClass, skipped: row.skipped },
        "purge kept leaves that hold undispatched events",
      );
    }
    if (removed < PURGE_BATCH) return total;
  }
  logger.warn(
    { class: retentionClass, removed: total },
    "purge stopped at its call limit; the next run continues",
  );
  return total;
}

function logged(logger: Logger, queue: string, run: () => Promise<unknown>): Promise<void> {
  return run().then(
    () => undefined,
    (error: unknown) => {
      logger.error({ queue, err: error }, "job failed");
      throw error;
    },
  );
}

async function register(boss: PgBoss, pool: AppPool, logger: Logger): Promise<void> {
  const options = { pollingIntervalSeconds: POLL_SECONDS };
  await boss.work("ensure_partitions", options, (jobs) =>
    logged(logger, "ensure_partitions", async () => {
      for (const job of jobs) parseJobPayload("ensure_partitions", job.data);
      await ensurePartitions(pool);
    }),
  );
  await boss.work("purge_expired", options, (jobs) =>
    logged(logger, "purge_expired", async () => {
      for (const job of jobs)
        await purgeExpired(pool, parseJobPayload("purge_expired", job.data).class, logger);
    }),
  );
  const missed = { missed: "once" } as const;
  await boss.schedule("ensure_partitions", JOB_QUEUES.ensure_partitions.cron, {}, missed);
  for (const name of RETENTION_CLASSES) {
    await boss.schedule(
      "purge_expired",
      JOB_QUEUES.purge_expired.cron,
      { class: name },
      { ...missed, key: name },
    );
  }
}

/**
 * Starts the queue client with its schedules, the 30 s heartbeat and the outbox relay. The first beat is made before
 * this returns, so a worker that cannot reach the database fails its start instead of looking alive.
 */
export async function startWorker({
  connectionString,
  pool,
  logger,
  role,
  heartbeatMs = HEARTBEAT_MS,
  relayIntervalMs = RELAY_INTERVAL_MS,
}: WorkerOptions): Promise<StartedWorker> {
  const boss = createBoss(connectionString, (error) => logger.error({ err: error }, "job queue error"));
  const workerId = randomUUID();
  const beat = () =>
    withSystem(pool, "heartbeat", (tx) => tx.query("SELECT app.worker_heartbeat($1, $2)", [workerId, role]));
  const relay = createOutboxRelay({ pool, handlers: {}, logger, intervalMs: relayIntervalMs });
  // A failed start stops the client, so its pool never stays open: `start` opens the pool before it checks the schema.
  try {
    await boss.start();
    await register(boss, pool, logger);
    await beat();
  } catch (error) {
    await boss
      .stop({ graceful: false, timeout: STOP_TIMEOUT_MS })
      .catch((stopError: unknown) => logger.error({ err: stopError }, "job queue did not stop"));
    throw error;
  }
  relay.start();
  const timer = setInterval(() => {
    beat().catch((error: unknown) => logger.error({ err: error }, "worker heartbeat failed"));
  }, heartbeatMs);
  return {
    async close() {
      clearInterval(timer);
      await relay.stop();
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },
  };
}
