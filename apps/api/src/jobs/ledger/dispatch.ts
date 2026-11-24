import {
  type AttemptResult,
  bucketKey,
  callTimeoutMs,
  finishAttempt,
  recordProgress,
  startAttempt,
} from "@shoutory/core/ledger/client";
import {
  type CallResult,
  type DispatchFacts,
  type ResultMove,
  resultMove,
} from "@shoutory/core/ledger/dispatch";
import type { TenantTx } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { AccountAccess, AdapterContext, ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import type { CredentialService } from "../../channels/credentials.js";
import type { Logger } from "../../logging/logger.js";
import {
  type ChannelFacts,
  fencedMove,
  type Held,
  handBack,
  inJob,
  move,
  movedOrLost,
  sqlOf,
  type TurnResult,
} from "./held.js";

export interface Caller {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly owner: string;
  readonly adapter: ProviderAdapter;
  readonly fetch: typeof fetch;
  readonly account: AccountAccess;
  readonly credentials: CredentialService;
  readonly now: () => number;
}
export interface Dispatcher extends Caller {
  readonly reconcileQueue: string;
  readonly closing: AbortSignal;
}

const snapshotSchema = z.object({
  draft: z.object({ variants: z.array(z.object({ channel_id: z.string(), text: z.string() })) }),
});

type Frozen =
  | { readonly text: string }
  | { readonly reason: "no_frozen_version" | "frozen_snapshot_unreadable" };

async function frozenText(pool: AppPool, held: Held): Promise<Frozen> {
  const { operation } = held;
  if (operation.frozen_version_id === null) return { reason: "no_frozen_version" };
  const { rows } = await inJob(pool, operation.workspace_id, (tx) =>
    tx.query<{ snapshot: unknown }>("SELECT snapshot FROM app.post_versions WHERE id = $1", [
      operation.frozen_version_id,
    ]),
  );
  const parsed = snapshotSchema.safeParse(rows[0]?.snapshot);
  const text = parsed.data?.draft.variants.find(
    (variant) => variant.channel_id === operation.channel_id,
  )?.text;
  return text === undefined ? { reason: "frozen_snapshot_unreadable" } : { text };
}

export function contextFor(deps: Caller, held: Held, timeoutMs: number): AdapterContext {
  const own = AbortSignal.any([held.signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  return {
    fetch: (input, init) =>
      deps.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, own]) : own }),
    now: () => new Date(),
  };
}

export const timeoutOf = (deps: Caller, held: Held): number | null =>
  callTimeoutMs({
    manifestTimeoutMs: held.manifest.callTimeoutSeconds * 1000,
    leaseSeconds: held.leaseSeconds,
    elapsedMs: deps.now() - held.started,
  });

export const call = (deps: Caller, held: Held) => ({
  workspaceId: held.claim.workspaceId,
  operationId: held.claim.id,
  token: held.claim.fencingToken,
  owner: deps.owner,
});

const factsOf = (held: Held): DispatchFacts => ({
  retryAfterMaxSeconds: held.manifest.retryAfterMaxSeconds,
  unverifiedHorizonDays: held.manifest.unverifiedHorizonDays,
  readBackMode: held.manifest.readBackMode,
  attemptCount: held.operation.attempt_count + 1,
  latenessLeftSeconds: held.operation.lateness_left_seconds,
});

function attemptOf(result: CallResult, outcome: ResultMove): AttemptResult {
  return {
    effect: outcome.row === 17 ? "confirmed" : outcome.row === 22 ? "possible" : "none",
    ...(result.httpStatus === undefined ? {} : { http_status: result.httpStatus }),
    ...(result.errorClass === undefined ? {} : { error_class: result.errorClass }),
    ...(result.retryAfterMs === undefined ? {} : { retry_after_ms: result.retryAfterMs }),
    // The read-back of this send must use the id this call answered with, never an older one on the row.
    ...(result.externalId === undefined ? {} : { response_excerpt: result.externalId }),
  };
}

async function applyMove(tx: TenantTx, deps: Dispatcher, held: Held, from: string, outcome: ResultMove) {
  switch (outcome.row) {
    case 17:
      return fencedMove(tx, held, from, "published", { evidence: outcome.evidence });
    case 22:
      return fencedMove(tx, held, from, "unknown_external_state", {
        checkInSeconds: outcome.checkInSeconds,
        queue: deps.reconcileQueue,
        horizonDays: outcome.horizonDays,
      });
    case 19:
      return fencedMove(tx, held, from, "retry_wait", { waitSeconds: outcome.waitSeconds });
    case 20:
      return fencedMove(tx, held, from, "failed");
    case 21:
      return fencedMove(tx, held, from, "paused", {
        reasonCode: outcome.reasonCode,
        waitSeconds: outcome.waitSeconds,
      });
  }
}

// The database refuses a pause longer than a day.
const MAX_PAUSE_SECONDS = 86_399;

// A provider's rate limit holds for everything on the account, so the buckets of the manifest's limits wait too.
async function pauseBuckets(
  tx: TenantTx,
  held: Held,
  channel: ChannelFacts,
  waitSeconds: number,
): Promise<void> {
  for (const limit of held.manifest.rateLimits) {
    const key = bucketKey({ limitName: limit.name, scope: limit.scope, keyName: limit.key, channel });
    await tx.query(
      "SELECT app.bucket_pause($1, $2, clock_timestamp() + make_interval(secs => $3::float8), 'rate_limited')",
      [key, limit.scope, Math.min(waitSeconds, MAX_PAUSE_SECONDS)],
    );
  }
}

interface Attempt {
  readonly id: string;
  readonly from: string;
}

// One transaction, so a crash cannot leave a finished attempt without its move. Nothing is written when the lease is lost.
async function settle(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  attempt: Attempt,
  result: CallResult,
): Promise<TurnResult> {
  const outcome = resultMove(result, factsOf(held));
  // A refused grant on a call that sent nothing is checked again first; a confirmed revocation moves the channel, and
  // the next turn's re-read holds the row for a reconnect.
  if (outcome.row === 19 && result.errorClass === "auth_revoked") {
    await deps.credentials.confirmRevoked(held.claim.workspaceId, held.operation.channel_id);
    if (held.signal.aborted) return lostTurn(held);
  }
  const done = await inJob(deps.pool, held.claim.workspaceId, async (tx) => {
    const finished = await finishAttempt(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      attemptId: attempt.id,
      token: held.claim.fencingToken,
      result: attemptOf(result, outcome),
    });
    if (finished !== "finished") return false;
    const moved = (await applyMove(tx, deps, held, attempt.from, outcome)).outcome === "moved";
    if (moved && result.errorClass === "rate_limited" && "waitSeconds" in outcome)
      await pauseBuckets(tx, held, channel, outcome.waitSeconds);
    return moved;
  });
  return done
    ? { kind: "dispatched", id: held.claim.id, to: outcome.to }
    : { kind: "lost", id: held.claim.id };
}

const lostTurn = (held: Held): TurnResult => ({ kind: "lost", id: held.claim.id });

// A failure in this validation step has no effect at the provider.
async function prepare(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  text: string,
): Promise<TurnResult | null> {
  const timeout = timeoutOf(deps, held);
  if (timeout === null) return handBack(deps.pool, held, "handed_back");
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "prepare" }),
  );
  if (started.outcome !== "started") return lostTurn(held);
  const result = await deps.adapter.prepare(contextFor(deps, held, timeout), {
    idempotencyKey: held.operation.idempotency_marker,
    text,
    account: deps.account,
  });
  if (held.signal.aborted) return lostTurn(held);
  if (!result.ok) return settle(deps, held, channel, { id: started.attemptId, from: "claimed" }, result);
  const recorded = await inJob(deps.pool, held.claim.workspaceId, async (tx) => {
    const finished = await finishAttempt(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      attemptId: started.attemptId,
      token: held.claim.fencingToken,
      result: { effect: "none" },
    });
    if (finished !== "finished") return "lost_lease";
    return recordProgress(sqlOf(tx), { ...call(deps, held), cursor: "prepare:1" });
  });
  return recorded === "recorded" ? null : lostTurn(held);
}

function quotasOf(held: Held) {
  return Object.fromEntries(
    held.manifest.quotas.map((quota) => [
      quota.name,
      { capacity: quota.max, window_seconds: quota.windowSeconds },
    ]),
  );
}

// The attempt is marked `possible` in its own committed transaction before the call, so a crash mid-call is never read as no effect.
async function commit(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  text: string,
): Promise<TurnResult> {
  const timeout = timeoutOf(deps, held);
  if (timeout === null) return handBack(deps.pool, held, "handed_back");
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "commit", quotas: quotasOf(held) }),
  );
  if (started.outcome === "lost_lease") return lostTurn(held);
  if (started.outcome === "quota_denied")
    return movedOrLost(held, "retry_wait", await move(deps.pool, held, "retry_wait", { waitSeconds: 60 }));
  const result = await deps.adapter.commit(contextFor(deps, held, timeout), {
    idempotencyKey: held.operation.idempotency_marker,
    text,
    account: deps.account,
  });
  if (held.signal.aborted) return lostTurn(held);
  return settle(deps, held, channel, { id: started.attemptId, from: "dispatching" }, result);
}

// The caller's heartbeat runs until this returns, so the lease holds through the call.
export async function dispatch(deps: Dispatcher, held: Held, channel: ChannelFacts): Promise<TurnResult> {
  const frozen = await frozenText(deps.pool, held);
  // The log line names the ids and the reason, never the post text.
  if ("reason" in frozen) {
    deps.logger.error(
      { operation: held.claim.id, workspace: held.claim.workspaceId, reason: frozen.reason },
      "operation has nothing to send",
    );
    return movedOrLost(held, "failed", await move(deps.pool, held, "failed"));
  }
  const { text } = frozen;
  if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
  const stopped = await prepare(deps, held, channel, text);
  if (stopped !== null) return stopped;
  if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
  return commit(deps, held, channel, text);
}
