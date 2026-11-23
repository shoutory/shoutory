import {
  bucketKey,
  claimOperation,
  denialMove,
  type PreflightMove,
  publishLeaseSeconds,
  rereadOutcome,
  takeBucket,
} from "@shoutory/core/ledger/client";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import { pastSunset } from "@shoutory/provider-sdk/snapshot";
import type { Logger } from "../../logging/logger.js";
import { dispatch } from "./dispatch.js";
import { hold } from "./heartbeat.js";
import {
  type ChannelFacts,
  type Held,
  handBack,
  inJob,
  move,
  movedOrLost,
  type Operation,
  readOperation,
  sqlOf,
  type TurnResult,
} from "./held.js";

export type { TurnResult } from "./held.js";

export interface TurnOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly registry: Registry;
  /** The adapter of each registered provider; a provider with none fails its operations. */
  readonly adapters: AdapterMap;
  /** The `fetch` an adapter of this provider is given: the one network path of the worker. */
  readonly fetchFor: (manifest: Manifest) => typeof fetch;
  readonly queue: string;
  /** The lease owner: one value for the worker process. */
  readonly owner: string;
  /** Aborts when the worker is closing: nothing new is claimed and a claimed row is handed back. */
  readonly closing: AbortSignal;
  /** A monotonic clock in milliseconds; the default is `performance.now`. */
  readonly now?: () => number;
  /** The calendar time, for the sunset of an API version; the default is the real clock. */
  readonly clock?: () => Date;
}

/**
 * One turn of a worker on a queue: it claims one due operation, keeps its lease alive, reads the channel and the target
 * again, and dispatches it: the marker, the one committing call, the result and its move. Every write is fenced by the
 * token it was handed, so a turn whose lease went elsewhere writes nothing more. It ends `lost` the moment the heartbeat
 * says so.
 */
export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { pool, closing, now = () => performance.now() } = options;
  if (closing.aborted) return { kind: "closed" };
  const started = now();
  const claim = await withSystem(pool, "ledger", (tx) =>
    claimOperation(sqlOf(tx), options.queue, options.owner),
  );
  if (claim === null) return { kind: "idle" };
  const operation = await readOperation(pool, claim);
  const manifest = options.registry.manifests.find((candidate) => candidate.id === operation.provider_id);
  if (manifest === undefined) {
    options.logger.error({ provider: operation.provider_id }, "claimed operation has no registered provider");
    throw new Error(`no provider "${operation.provider_id}" is registered`);
  }
  const holding = hold({
    pool,
    logger: options.logger,
    claim,
    operation,
    manifest,
    leaseSeconds: publishLeaseSeconds(manifest.leaseSeconds),
    owner: options.owner,
    now,
    started,
  });
  try {
    return await preflight(options, holding.held);
  } finally {
    await holding.stop();
  }
}

// The channel, then the variant and the post of the target, as they are now.
async function readTarget(pool: AppPool, operation: Operation) {
  return inJob(pool, operation.workspace_id, async (tx) => {
    const channel = await tx.query<ChannelFacts>(
      `SELECT provider_id, provider_account_id, instance_host, connection_state
         FROM app.channels WHERE id = $1`,
      [operation.channel_id],
    );
    const variant = await tx.query<{ schedule_state: string }>(
      "SELECT schedule_state FROM app.post_variants WHERE id = $1",
      [operation.variant_id],
    );
    const post = await tx.query<{ status: string; deleted_at: Date | null }>(
      `SELECT p.status, p.deleted_at FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id AND v.workspace_id = p.workspace_id
         WHERE v.id = $1`,
      [operation.variant_id],
    );
    const live = variant.rows[0] !== undefined && post.rows[0] !== undefined;
    return {
      channel: channel.rows[0],
      targetLive:
        live &&
        variant.rows[0]?.schedule_state !== "settled" &&
        post.rows[0]?.status !== "archived" &&
        post.rows[0]?.deleted_at === null,
    };
  });
}

async function preflightMove(pool: AppPool, held: Held, outcome: PreflightMove): Promise<TurnResult> {
  const changes: { reasonCode?: string; waitSeconds?: number } = {};
  if (outcome.to === "paused") changes.reasonCode = outcome.reasonCode;
  if ("waitSeconds" in outcome && outcome.waitSeconds !== undefined)
    changes.waitSeconds = outcome.waitSeconds;
  const moved = await move(pool, held, outcome.to, changes);
  return movedOrLost(held, outcome.to, moved, outcome.to === "paused" ? outcome.reasonCode : undefined);
}

// Spends one token of each rate limit of the manifest, in its order, and stops at the first denial (the tokens already
// taken stay spent: a turn never sends more than the limits allow). Answers the move that denial calls for, or null.
async function takeLimits(
  pool: AppPool,
  held: Held,
  channel: ChannelFacts,
  stopped: () => boolean,
): Promise<PreflightMove | null> {
  for (const limit of held.manifest.rateLimits) {
    const key = bucketKey({ limitName: limit.name, scope: limit.scope, keyName: limit.key, channel });
    const answer = await inJob(pool, held.claim.workspaceId, (tx) =>
      takeBucket(sqlOf(tx), {
        key,
        scope: limit.scope,
        capacity: limit.max,
        windowSeconds: limit.windowSeconds,
      }),
    );
    if (stopped()) return null;
    if (!answer.allowed) {
      return denialMove({
        retryAfterSeconds: answer.retryAfterSeconds,
        retryAfterMaxSeconds: held.manifest.retryAfterMaxSeconds,
        latenessLeftSeconds: held.operation.lateness_left_seconds,
      });
    }
  }
  return null;
}

async function preflight(options: TurnOptions, held: Held): Promise<TurnResult> {
  const { pool, closing, now = () => performance.now() } = options;
  const { claim, operation, manifest, signal } = held;
  const lost: TurnResult = { kind: "lost", id: claim.id };
  if (closing.aborted) return handBack(pool, held, "closed");
  const target = await readTarget(pool, operation);
  if (signal.aborted) return lost;
  // A channel the worker cannot see is a removed target: the operation fails.
  const { channel } = target;
  if (channel === undefined) return preflightMove(pool, held, { to: "failed" });
  const outcome = rereadOutcome({ channelState: channel.connection_state, targetLive: target.targetLive });
  if (outcome !== null) return preflightMove(pool, held, outcome);
  // A provider whose API has retired sends nothing and spends no token: the row waits, visibly, until a live version is named.
  if (pastSunset(manifest, (options.clock ?? (() => new Date()))()))
    return preflightMove(pool, held, { to: "paused", reasonCode: "api_sunset" });
  if (closing.aborted) return handBack(pool, held, "closed");
  const denied = await takeLimits(pool, held, channel, () => signal.aborted || closing.aborted);
  if (signal.aborted) return lost;
  if (closing.aborted) return handBack(pool, held, "closed");
  if (denied !== null) return preflightMove(pool, held, denied);
  const adapter = options.adapters[manifest.id];
  if (adapter === undefined) {
    options.logger.error({ provider: manifest.id }, "claimed operation has no adapter");
    return preflightMove(pool, held, { to: "failed" });
  }
  const deps = {
    pool,
    logger: options.logger,
    owner: options.owner,
    adapter,
    fetch: options.fetchFor(manifest),
    now,
    reconcileQueue: options.registry.queueNames(manifest.id).reconcile,
    closing,
  };
  return dispatch(deps, held, channel);
}
