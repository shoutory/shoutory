import {
  bucketKey,
  type Claim,
  callTimeoutMs,
  claimOperation,
  denialMove,
  type PreflightMove,
  publishLeaseSeconds,
  rereadOutcome,
  takeBucket,
  transition,
} from "@shoutory/core/ledger/client";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import type { Logger } from "../../logging/logger.js";
import { startHeartbeat } from "./heartbeat.js";

export interface TurnOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly queue: string;
  /** The lease owner: one value for the worker process. */
  readonly owner: string;
  /** Aborts when the worker is closing: nothing new is claimed and a claimed row is handed back. */
  readonly closing: AbortSignal;
  /** A monotonic clock in milliseconds; the default is `performance.now`. */
  readonly now?: () => number;
}
export type TurnResult =
  | { kind: "idle" }
  | { kind: "closed" }
  | { kind: "handed_back" }
  | { kind: "lost"; id: string }
  | { kind: "moved"; id: string; to: string; reason?: string }
  | { kind: "ready"; id: string; token: string; callTimeoutMs: number };

interface Operation {
  readonly id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly variant_id: string;
  readonly provider_id: string;
  /** What is left of the lateness window, blocked time not counted, as the database counts it. */
  readonly lateness_left_seconds: number;
}
interface ChannelFacts {
  readonly provider_id: string;
  readonly provider_account_id: string | null;
  readonly instance_host: string | null;
  readonly connection_state: string;
}

const sqlOf = (tx: TenantTx) => (text: string, values: unknown[]) => tx.query(text, values);
const asJob = (workspaceId: string) =>
  ({ principalKind: "job", jobPurpose: "ledger", workspaceIds: [workspaceId] }) as const;

/**
 * One turn of a worker on a queue: it claims one due operation, keeps its lease alive, reads the channel and the target
 * again, and ends at the point where the provider call would begin. Every write is fenced by the token it was handed, so a
 * turn whose lease went elsewhere writes nothing more. It ends `lost` the moment the heartbeat says so.
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
  const leaseSeconds = publishLeaseSeconds(manifest.leaseSeconds);
  const beating = startHeartbeat({
    pool,
    logger: options.logger,
    workspaceId: claim.workspaceId,
    id: claim.id,
    token: claim.fencingToken,
    owner: options.owner,
    leaseSeconds,
    now,
    claimStartedMs: started,
  });
  try {
    return await preflight(options, {
      claim,
      operation,
      manifest,
      leaseSeconds,
      started,
      signal: beating.signal,
    });
  } finally {
    await beating.stop();
  }
}

interface Held {
  readonly claim: Claim;
  readonly operation: Operation;
  readonly manifest: Manifest;
  readonly leaseSeconds: number;
  readonly started: number;
  readonly signal: AbortSignal;
}

async function readOperation(pool: AppPool, claim: Claim): Promise<Operation> {
  const { rows } = await withTenant(pool, asJob(claim.workspaceId), (tx) =>
    tx.query<Operation>(
      `SELECT id, workspace_id, channel_id, variant_id, provider_id,
              extract(epoch FROM lateness_deadline + blocked_total - clock_timestamp())::float8 AS lateness_left_seconds
         FROM app.operations WHERE id = $1`,
      [claim.id],
    ),
  );
  if (rows[0] === undefined) throw new Error("the claimed operation cannot be read");
  return rows[0];
}

// The channel, then the variant and the post of the target, as they are now.
async function readTarget(pool: AppPool, operation: Operation) {
  return withTenant(pool, asJob(operation.workspace_id), async (tx) => {
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

/** Moves the claimed row by one fenced pre-flight move of the worker (row 12, or row 10 to hand it back). */
async function move(
  pool: AppPool,
  held: Held,
  to: string,
  changes: { reasonCode?: string; waitSeconds?: number } = {},
): Promise<boolean> {
  const result = await withTenant(pool, asJob(held.claim.workspaceId), async (tx) => {
    // A wait is counted by the database clock, in seconds from now, never by this process's clock.
    const due =
      changes.waitSeconds === undefined
        ? undefined
        : (
            await tx.query<{ at: string }>(
              "SELECT (clock_timestamp() + make_interval(secs => $1::float8))::text AS at",
              [changes.waitSeconds],
            )
          ).rows[0]?.at;
    return transition(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      operationId: held.claim.id,
      token: held.claim.fencingToken,
      from: "claimed",
      to,
      actor: "W",
      changes: {
        ...(changes.reasonCode === undefined ? {} : { reason_code: changes.reasonCode }),
        ...(due === undefined ? {} : { next_attempt_at: due }),
      },
    });
  });
  return result.outcome === "moved";
}

async function preflightMove(pool: AppPool, held: Held, outcome: PreflightMove): Promise<TurnResult> {
  const changes: { reasonCode?: string; waitSeconds?: number } = {};
  if (outcome.to === "paused") changes.reasonCode = outcome.reasonCode;
  if (outcome.to !== "failed" && outcome.waitSeconds !== undefined) changes.waitSeconds = outcome.waitSeconds;
  if (!(await move(pool, held, outcome.to, changes))) return { kind: "lost", id: held.claim.id };
  return {
    kind: "moved",
    id: held.claim.id,
    to: outcome.to,
    ...(outcome.to === "paused" ? { reason: outcome.reasonCode } : {}),
  };
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
    const answer = await withTenant(pool, asJob(held.claim.workspaceId), (tx) =>
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
  const handBack = async (kind: "closed" | "handed_back" = "closed"): Promise<TurnResult> =>
    (await move(pool, held, "pending")) ? { kind } : { kind: "lost", id: claim.id };
  const lost: TurnResult = { kind: "lost", id: claim.id };
  if (closing.aborted) return handBack();
  const target = await readTarget(pool, operation);
  if (signal.aborted) return lost;
  // A channel the worker cannot see is a removed target: the operation fails.
  const { channel } = target;
  if (channel === undefined) return preflightMove(pool, held, { to: "failed" });
  const outcome = rereadOutcome({ channelState: channel.connection_state, targetLive: target.targetLive });
  if (outcome !== null) return preflightMove(pool, held, outcome);
  if (closing.aborted) return handBack();
  const denied = await takeLimits(pool, held, channel, () => signal.aborted || closing.aborted);
  if (signal.aborted) return lost;
  if (closing.aborted) return handBack();
  if (denied !== null) return preflightMove(pool, held, denied);
  const timeout = callTimeoutMs({
    manifestTimeoutMs: manifest.callTimeoutSeconds * 1000,
    leaseSeconds: held.leaseSeconds,
    elapsedMs: now() - held.started,
  });
  if (signal.aborted) return lost;
  // Too little lease for a call: the row goes back to pending now instead of staying leased until the lease ends.
  if (timeout === null) return handBack("handed_back");
  return { kind: "ready", id: claim.id, token: claim.fencingToken, callTimeoutMs: timeout };
}
