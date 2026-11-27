import type { StorageDriver } from "@shoutory/core/storage";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import type { PgBoss } from "pg-boss";
import type { CredentialService } from "../../channels/credentials.js";
import type { Logger } from "../../logging/logger.js";
import { runTurn } from "./turn.js";

// One job drains at most this many turns; a queue that still has work gets a new wake-up, so one job never holds the
// worker for ever and the queue's other jobs are not starved.
const MAX_TURNS_PER_JOB = 10;
// A wake-up waits at most this long for its worker: a post due now is not held back for the queue's default poll.
const POLL_SECONDS = 1;

export interface PublishSubscription {
  readonly pool: AppPool;
  readonly boss: PgBoss;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly adapters: AdapterMap;
  readonly fetchFor: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly credentials: CredentialService;
  readonly owner: string;
  readonly closing: AbortSignal;
  readonly storage: StorageDriver;
}

// A wake-up carries nothing: the ledger row is the truth.
export async function subscribePublish(options: PublishSubscription): Promise<void> {
  for (const manifest of options.registry.manifests) {
    if (options.adapters[manifest.id] === undefined) continue;
    const queue = options.registry.queueNames(manifest.id).publish;
    await options.boss.work(queue, { localConcurrency: 1, pollingIntervalSeconds: POLL_SECONDS }, () =>
      drain(options, queue),
    );
  }
}

async function drain(options: PublishSubscription, queue: string): Promise<void> {
  const { pool, logger, registry, adapters, fetchFor, credentials, owner, closing, storage } = options;
  for (let turns = 0; turns < MAX_TURNS_PER_JOB; turns++) {
    const result = await runTurn({
      pool,
      logger,
      registry,
      adapters,
      fetchFor,
      credentials,
      queue,
      owner,
      closing,
      storage,
    });
    if (result.kind === "idle" || result.kind === "closed") return;
  }
  // The limit was reached with work left: one more wake-up (the queue keeps at most one waiting).
  await options.boss.send(queue, {}, { singletonKey: queue, retryLimit: 0 });
}
