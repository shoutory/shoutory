import { randomUUID } from "node:crypto";
import { withSystem } from "@shoutory/db/context/system";
import { withAdvisoryLock } from "@shoutory/db/locks";
import type { AppPool } from "@shoutory/db/pool";
import { builtInManifests } from "@shoutory/provider-registry";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import { createRegistry, type Registry } from "@shoutory/provider-sdk/registry";
import type { PgBoss } from "pg-boss";
import {
  type CredentialService,
  channelProvidersOf,
  createCredentialService,
  sweepCredentials,
} from "../channels/credentials.js";
import type { Logger } from "../logging/logger.js";
import { sweepStaleFiles } from "../storage/fs-sweep.js";
import { createBoss } from "./boss.js";
import { refuseEgress } from "./ledger/held.js";
import { subscribePublish } from "./ledger/subscribe.js";
import { createLedgerTick } from "./ledger/tick.js";
import { createMailSender, type MailSenderOptions } from "./mail-sender.js";
import { collectMedia } from "./media/gc.js";
import type { PipelineDeps } from "./media/pipeline.js";
import { sweepScratch } from "./media/scratch.js";
import { mediaUploadedHandler } from "./media/uploaded.js";
import { createOutboxRelay, type IntervalLoop, type OutboxRelayOptions } from "./outbox-relay.js";
import {
  JOB_QUEUES,
  PARTITION_CLASSES,
  PROVIDER_QUEUE_OPTIONS,
  parseJobPayload,
  RETENTION_CLASSES,
} from "./registry.js";

export interface WorkerOptions {
  readonly connectionString: string;
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly role: "worker" | "all";
  readonly media: Pick<PipelineDeps, "storage" | "scan" | "ffprobe" | "scratchDir"> & {
    // Set only for the filesystem driver: the nightly sweep of upload parts runs over it.
    readonly partsRoot?: string;
  };
  readonly mail: Pick<
    MailSenderOptions,
    "keys" | "pepper" | "smtpUrl" | "from" | "marketingFrom" | "publicOrigin"
  >;
  readonly registry?: Registry;
  // A provider with no adapter is admitted but never dispatched (its rows fail).
  readonly adapters?: AdapterMap;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly heartbeatMs?: number;
  readonly relayIntervalMs?: number;
  readonly mailIntervalMs?: number;
  readonly ledgerIntervalMs?: number;
}
export interface StartedWorker {
  close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;
const RELAY_INTERVAL_MS = 1_000;
const POLL_SECONDS = 30;
const STOP_TIMEOUT_MS = 10_000;
// An upload can run for half an hour (a large video is copied twice at the storage's pace), so it has a relay of its
// own that takes one row at a time and beats its claim; the general relay never waits behind it.
const MEDIA_EVENTS = ["media.uploaded"];
const MEDIA_HANDLER_TIMEOUT_MS = 30 * 60_000;
const MEDIA_HEARTBEAT_MS = 60_000;

function createRelays(
  options: Pick<OutboxRelayOptions, "pool" | "handlers" | "logger" | "intervalMs">,
): IntervalLoop {
  const general = createOutboxRelay({ ...options, excludeTypes: MEDIA_EVENTS });
  const media = createOutboxRelay({
    ...options,
    types: MEDIA_EVENTS,
    batch: 1,
    handlerTimeoutMs: MEDIA_HANDLER_TIMEOUT_MS,
    heartbeatMs: MEDIA_HEARTBEAT_MS,
  });
  return {
    start() {
      general.start();
      media.start();
    },
    async stop() {
      await Promise.all([general.stop(), media.stop()]);
    },
  };
}
// A purge call removes at most this many rows; the job calls again while one comes back full, and stops after
// MAX_PURGE_CALLS so one run cannot hold a connection for ever: the next night continues.
const PURGE_BATCH = 5_000;
// A run refreshes at most this many channels; the sweep's order makes the next run start where this one stopped.
const REFRESH_BATCH = 100;
const MAX_PURGE_CALLS = 1_000;

// One instance-wide key for every statement that takes ACCESS EXCLUSIVE on a partitioned parent.
const PARTITION_LOCK_KEY = "partitions";

type SystemTx = Parameters<Parameters<typeof withSystem>[2]>[0];
const underPartitionLock = <T>(pool: AppPool, run: (tx: SystemTx) => Promise<T>): Promise<T> =>
  withSystem(pool, "maintenance", (tx) =>
    withAdvisoryLock(tx, "maintenance", () => run(tx), PARTITION_LOCK_KEY),
  );

export function ensurePartitions(pool: AppPool): Promise<number> {
  return underPartitionLock(
    pool,
    async (tx) =>
      (await tx.query<{ made: number }>("SELECT app.ensure_partitions() AS made")).rows[0]?.made ?? 0,
  );
}

// A partition class takes the same lock as `ensurePartitions`, so a purge never races it on one parent.
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

export async function sweepUploadParts(
  root: string,
  logger: Logger,
  { now = new Date(), deadlineMs }: { now?: Date; deadlineMs?: number } = {},
): Promise<void> {
  const { removed, visited, cut } = await sweepStaleFiles(root, now, {
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  if (cut) logger.warn({ removed, visited }, "the sweep of upload parts stopped at its deadline");
  else logger.info({ removed, visited }, "the sweep of upload parts finished");
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

// Another driver removes a stale schedule: one left from a time the instance ran on the filesystem would never be
// worked and the queue lag would grow.
async function scheduleSweep(boss: PgBoss, logger: Logger, partsRoot: string | undefined): Promise<void> {
  if (partsRoot === undefined) return boss.unschedule("sweep_upload_parts");
  await boss.work("sweep_upload_parts", { pollingIntervalSeconds: POLL_SECONDS }, (jobs) =>
    logged(logger, "sweep_upload_parts", async () => {
      for (const job of jobs) parseJobPayload("sweep_upload_parts", job.data);
      await sweepUploadParts(partsRoot, logger);
    }),
  );
  await boss.schedule("sweep_upload_parts", JOB_QUEUES.sweep_upload_parts.cron, {}, { missed: "once" });
}

async function scheduleRefresh(
  boss: PgBoss,
  pool: AppPool,
  logger: Logger,
  credentials: CredentialService,
): Promise<void> {
  await boss.work("credential_refresh", { pollingIntervalSeconds: POLL_SECONDS }, (jobs) =>
    logged(logger, "credential_refresh", async () => {
      for (const job of jobs) parseJobPayload("credential_refresh", job.data);
      await sweepCredentials({ pool, credentials, logger, limit: REFRESH_BATCH });
    }),
  );
  await boss.schedule("credential_refresh", JOB_QUEUES.credential_refresh.cron, {}, { missed: "once" });
}

async function register(
  boss: PgBoss,
  pool: AppPool,
  logger: Logger,
  media: WorkerOptions["media"],
): Promise<void> {
  const options = { pollingIntervalSeconds: POLL_SECONDS };
  await boss.work("media_gc", options, (jobs) =>
    logged(logger, "media_gc", async () => {
      for (const job of jobs) parseJobPayload("media_gc", job.data);
      await collectMedia({ pool, storage: media.storage, logger });
    }),
  );
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
  await boss.schedule("media_gc", JOB_QUEUES.media_gc.cron, {}, missed);
  for (const name of RETENTION_CLASSES) {
    await boss.schedule(
      "purge_expired",
      JOB_QUEUES.purge_expired.cron,
      { class: name },
      { ...missed, key: name },
    );
  }
  await scheduleSweep(boss, logger, media.partsRoot);
}

// The first beat is made before this returns, so a worker that cannot reach the database fails its start instead of
// looking alive.
export async function startWorker({
  connectionString,
  pool,
  logger,
  role,
  media,
  mail,
  registry = createRegistry(builtInManifests),
  adapters = {},
  fetchFor = refuseEgress,
  heartbeatMs = HEARTBEAT_MS,
  relayIntervalMs = RELAY_INTERVAL_MS,
  mailIntervalMs = RELAY_INTERVAL_MS,
  ledgerIntervalMs,
}: WorkerOptions): Promise<StartedWorker> {
  const boss = createBoss(connectionString, (error) => logger.error({ err: error }, "job queue error"));
  const workerId = randomUUID();
  const closing = new AbortController();
  const beat = () =>
    withSystem(pool, "heartbeat", (tx) => tx.query("SELECT app.worker_heartbeat($1, $2)", [workerId, role]));
  const handlers = { "media.uploaded": mediaUploadedHandler({ pool, logger, ...media }) };
  const relays = createRelays({ pool, handlers, logger, intervalMs: relayIntervalMs });
  const sender = createMailSender({ ...mail, pool, logger, intervalMs: mailIntervalMs });
  // The mail sender's key ring is the instance's, and it also opens the credentials of the channels a send is for.
  const credentials = createCredentialService({
    pool,
    keys: mail.keys,
    pepper: mail.pepper,
    fetch: refuseEgress(),
    fetchFor,
    now: () => new Date(),
    logger,
    providers: channelProvidersOf(registry, adapters),
  });
  const sends = { pool, boss, registry, logger, adapters, fetchFor, credentials };
  const ledger = createLedgerTick({
    ...sends,
    ...(ledgerIntervalMs === undefined ? {} : { intervalMs: ledgerIntervalMs }),
  });
  // A failed start stops the client, so its pool never stays open: `start` opens the pool before it checks the schema.
  try {
    await sweepScratch(media.scratchDir);
    await boss.start();
    // Idempotent: a provider added without `shoutory migrate` must not stall admission on a queue that is missing.
    for (const name of registry.allQueueNames()) await boss.createQueue(name, PROVIDER_QUEUE_OPTIONS);
    await register(boss, pool, logger, media);
    await scheduleRefresh(boss, pool, logger, credentials);
    await subscribePublish({ ...sends, owner: `worker-${workerId}`, closing: closing.signal });
    await beat();
  } catch (error) {
    await boss
      .stop({ graceful: false, timeout: STOP_TIMEOUT_MS })
      .catch((stopError: unknown) => logger.error({ err: stopError }, "job queue did not stop"));
    throw error;
  }
  relays.start();
  sender.start();
  ledger.start();
  const timer = setInterval(() => {
    beat().catch((error: unknown) => logger.error({ err: error }, "worker heartbeat failed"));
  }, heartbeatMs);
  return {
    async close() {
      clearInterval(timer);
      // A turn in flight hands its row back and no new one starts; the queue client waits for the turns when it stops.
      closing.abort();
      // The tick stops first: it sends wake-ups through the queue client, which stops last.
      await ledger.stop();
      await Promise.all([relays.stop(), sender.stop()]);
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
    },
  };
}
