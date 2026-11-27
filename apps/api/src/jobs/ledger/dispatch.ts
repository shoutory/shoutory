import {
  type AttemptResult,
  bucketKey,
  callTimeoutMs,
  denialMove,
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
import type { StorageDriver } from "@shoutory/core/storage";
import type { TenantTx } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type {
  AccountAccess,
  AdapterContext,
  CommitInput,
  MediaReader,
  ProviderAdapter,
} from "@shoutory/provider-sdk/adapter";
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
  preflightMove,
  sqlOf,
  type TurnResult,
  takeLimits,
} from "./held.js";
import { mediaReader } from "./media.js";

export interface Caller {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly owner: string;
  readonly adapter: ProviderAdapter;
  readonly fetch: typeof fetch;
  readonly account: AccountAccess;
  readonly credentials: CredentialService;
  readonly now: () => number;
  readonly clock: () => Date;
}
export interface Dispatcher extends Caller {
  readonly reconcileQueue: string;
  readonly closing: AbortSignal;
  readonly storage?: StorageDriver;
}

const snapshotSchema = z.object({
  draft: z.object({
    variants: z.array(
      z.object({
        channel_id: z.string(),
        locale: z.string().nullable(),
        text: z.string(),
        parts: z
          .array(z.object({ kind: z.enum(["thread_reply", "first_comment"]), text: z.string() }))
          .default([]),
        media: z.array(z.object({ alt_text: z.string().nullable() })),
      }),
    ),
  }),
  resolved: z.object({
    variants: z.array(
      z.object({
        channel_id: z.string(),
        locale: z.string().nullable(),
        settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      }),
    ),
  }),
});

type Frozen =
  | {
      readonly text: string;
      readonly alts: readonly (string | null)[];
      readonly settings: Readonly<Record<string, string | number | boolean>>;
      readonly locale: string | null;
      /** The part this follow-up replies to; null for the root. */
      readonly replyToPart: number | null;
    }
  | { readonly reason: "no_frozen_version" | "frozen_snapshot_unreadable" };

type FollowUp = z.infer<typeof snapshotSchema>["draft"]["variants"][number]["parts"][number];

// A thread reply answers the nearest earlier thread reply, else the root; a first comment answers the root.
function replyTarget(parts: readonly FollowUp[], part: number): number {
  if (parts[part - 1]?.kind !== "thread_reply") return 0;
  for (let earlier = part - 1; earlier > 0; earlier--) {
    if (parts[earlier - 1]?.kind === "thread_reply") return earlier;
  }
  return 0;
}

// The variant is the one of the operation's channel and locale: a post may hold one variant per locale of a channel.
export async function frozenFacts(pool: AppPool, held: Held): Promise<Frozen> {
  const { operation } = held;
  if (operation.frozen_version_id === null) return { reason: "no_frozen_version" };
  const { rows } = await inJob(pool, operation.workspace_id, (tx) =>
    tx.query<{ snapshot: unknown }>("SELECT snapshot FROM app.post_versions WHERE id = $1", [
      operation.frozen_version_id,
    ]),
  );
  const snapshot = snapshotSchema.safeParse(rows[0]?.snapshot).data;
  const ours = (candidate: { channel_id: string; locale: string | null }) =>
    candidate.channel_id === operation.channel_id && candidate.locale === operation.locale;
  const variant = snapshot?.draft.variants.find(ours);
  if (snapshot === undefined || variant === undefined) return { reason: "frozen_snapshot_unreadable" };
  const part = operation.part_index;
  const followUp = part === 0 ? undefined : variant.parts[part - 1];
  if (part > 0 && followUp === undefined) return { reason: "frozen_snapshot_unreadable" };
  return {
    text: followUp?.text ?? variant.text,
    alts: followUp === undefined ? variant.media.map((medium) => medium.alt_text) : [],
    settings: snapshot.resolved.variants.find(ours)?.settings ?? {},
    locale: variant.locale,
    replyToPart: followUp === undefined ? null : replyTarget(variant.parts, part),
  };
}

export function contextFor(deps: Caller, held: Held, timeoutMs: number, media?: MediaReader): AdapterContext {
  const own = AbortSignal.any([held.signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  return {
    fetch: (input, init) =>
      deps.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, own]) : own }),
    now: deps.clock,
    ...(media === undefined ? {} : { media }),
  };
}

// The call's own timeout; the heartbeat keeps the lease alive through it, and a lost heartbeat aborts the call through
// the held signal.
export const timeoutOf = (
  deps: Caller,
  held: Held,
  seconds: number = held.manifest.callTimeoutSeconds,
): number | null =>
  callTimeoutMs({ callTimeoutMs: seconds * 1000, leaseEndMs: held.leaseEnd(), nowMs: deps.now() });

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
  kind: held.claim.kind,
  targetExternalId: held.operation.target_external_id ?? undefined,
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

export const refsSchema = z.object({
  media: z.array(z.object({ id: z.string(), processing: z.boolean() })).default([]),
});
type MediaRef = z.infer<typeof refsSchema>["media"][number];

interface Prepared {
  readonly refs: readonly MediaRef[];
  readonly checkInSeconds: number | undefined;
}

// One adapter call that may upload one medium. A failure in this step has no effect at the provider.
async function prepareStep(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  input: { text: string; media: MediaReader; refs: readonly MediaRef[]; cursor: string },
): Promise<TurnResult | Prepared> {
  const uploading = input.media.items.length > 0;
  const seconds = uploading
    ? (held.manifest.uploadTimeoutSeconds ?? held.manifest.callTimeoutSeconds)
    : held.manifest.callTimeoutSeconds;
  const timeout = timeoutOf(deps, held, seconds);
  if (timeout === null) return handBack(deps.pool, held, "handed_back");
  if (uploading) {
    const denied = await takeLimits(deps.pool, held, channel, "upload", () => held.signal.aborted);
    if (held.signal.aborted) return lostTurn(held);
    if (denied !== null) return preflightMove(deps.pool, held, denied);
  }
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "prepare" }),
  );
  if (started.outcome !== "started") return lostTurn(held);
  const result = await deps.adapter.prepare(contextFor(deps, held, timeout, input.media), {
    idempotencyKey: held.operation.idempotency_marker,
    text: input.text,
    account: deps.account,
    mediaIds: input.refs.map((ref) => ref.id),
  });
  if (held.signal.aborted) return lostTurn(held);
  if (!result.ok) return settle(deps, held, channel, { id: started.attemptId, from: "claimed" }, result);
  const refs = result.upload
    ? [...input.refs, { id: result.upload.mediaId, processing: result.upload.processing !== undefined }]
    : input.refs;
  const recorded = await inJob(deps.pool, held.claim.workspaceId, async (tx) => {
    const finished = await finishAttempt(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      attemptId: started.attemptId,
      token: held.claim.fencingToken,
      result: { effect: "none" },
    });
    if (finished !== "finished") return "lost_lease";
    return recordProgress(sqlOf(tx), {
      ...call(deps, held),
      cursor: input.cursor,
      ...(result.upload ? { refs: { media: refs } } : {}),
    });
  });
  if (recorded !== "recorded") return lostTurn(held);
  return { refs, checkInSeconds: result.upload?.processing?.checkInSeconds };
}

const isTurn = (value: object): value is TurnResult => "kind" in value;

// A medium that the provider is still processing parks the operation: nothing is published until it is ready.
async function awaitProcessing(deps: Dispatcher, held: Held, hint: number | undefined): Promise<TurnResult> {
  const moved = await move(deps.pool, held, "processing", {
    processingSeconds: held.manifest.maxProcessingSeconds ?? held.manifest.maxInFlightSeconds,
    checkInSeconds: hint ?? held.manifest.readBackGapSeconds,
    stepCursor: "await_processing",
  });
  return movedOrLost(held, "processing", moved);
}

// The provider's own prepare step runs once for a post without media, and once per medium for one with: each upload
// is its own call, token and recorded step, so a retry reuses the ids already stored and never uploads one twice.
async function prepare(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  text: string,
  media: MediaReader,
): Promise<TurnResult | readonly MediaRef[]> {
  const refs = refsSchema.parse(held.operation.provider_refs ?? {}).media;
  // Every medium was ready when the cursor reached `commit`: a send that follows only uses the stored ids.
  if (held.operation.step_cursor === "commit") return refs;
  if (media.items.length === 0) {
    const stepped = await prepareStep(deps, held, channel, { text, media, refs, cursor: "prepare:1" });
    return isTurn(stepped) ? stepped : stepped.refs;
  }
  return uploadAll(deps, held, channel, { text, media, refs });
}

async function uploadAll(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  input: { text: string; media: MediaReader; refs: readonly MediaRef[] },
): Promise<TurnResult | readonly MediaRef[]> {
  let refs = input.refs;
  let hint = Number.POSITIVE_INFINITY;
  while (refs.length < input.media.items.length) {
    if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
    const stepped = await prepareStep(deps, held, channel, {
      ...input,
      refs,
      cursor: `prepare:${refs.length + 1}`,
    });
    if (isTurn(stepped)) return stepped;
    if (stepped.refs.length === refs.length) return failedMedium(deps, held);
    refs = stepped.refs;
    hint = Math.min(hint, stepped.checkInSeconds ?? hint);
  }
  if (!refs.some((ref) => ref.processing)) return refs;
  return awaitProcessing(deps, held, Number.isFinite(hint) ? hint : undefined);
}

// A provider that answers a medium's step with no medium cannot publish the post as it was written.
async function failedMedium(deps: Dispatcher, held: Held): Promise<TurnResult> {
  deps.logger.error(
    { operation: held.claim.id, workspace: held.claim.workspaceId },
    "the provider did not take a medium",
  );
  return movedOrLost(held, "failed", await move(deps.pool, held, "failed"));
}

function quotasOf(held: Held) {
  return Object.fromEntries(
    held.manifest.quotas.map((quota) => [
      quota.name,
      { capacity: quota.max, window_seconds: quota.windowSeconds },
    ]),
  );
}

type Source = "claimed" | "processing";

// A claimed row waits or pauses by the denial. A processing row has no pause, so it waits, never longer than the
// manifest allows or the lateness leaves; its next turn takes the limits again and pauses it if they still say so.
export async function quotaDenied(
  deps: Dispatcher,
  held: Held,
  seconds: number,
  from: Source,
): Promise<TurnResult> {
  if (from === "processing") {
    const room = Math.min(held.manifest.retryAfterMaxSeconds, held.operation.lateness_left_seconds);
    const moved = await move(
      deps.pool,
      held,
      "retry_wait",
      { waitSeconds: Math.max(1, Math.min(seconds, room)) },
      from,
    );
    return movedOrLost(held, "retry_wait", moved);
  }
  return preflightMove(
    deps.pool,
    held,
    denialMove({
      retryAfterSeconds: seconds,
      retryAfterMaxSeconds: held.manifest.retryAfterMaxSeconds,
      latenessLeftSeconds: held.operation.lateness_left_seconds,
    }),
  );
}

// The attempt is marked `possible` in its own committed transaction before the call, so a crash mid-call is never read as no effect.
async function commit(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  text: string,
  media: { reader: MediaReader; ids: readonly string[] },
  facts: Pick<CommitInput, "settings" | "locale" | "replyToExternalId">,
  from: Source = "claimed",
): Promise<TurnResult> {
  const timeout = timeoutOf(deps, held);
  // A processing row has no way back to pending: it keeps its lease and the next poll finds it again.
  if (timeout === null)
    return from === "claimed" ? handBack(deps.pool, held, "handed_back") : { kind: "handed_back" };
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "commit", quotas: quotasOf(held) }),
  );
  if (started.outcome === "lost_lease") return lostTurn(held);
  if (started.outcome === "quota_denied") return quotaDenied(deps, held, started.retryAfterSeconds, from);
  const result = await deps.adapter.commit(contextFor(deps, held, timeout, media.reader), {
    idempotencyKey: held.operation.idempotency_marker,
    text,
    ...facts,
    account: deps.account,
    ...(media.ids.length === 0 ? {} : { mediaIds: media.ids }),
  });
  if (held.signal.aborted) return lostTurn(held);
  return settle(deps, held, channel, { id: started.attemptId, from: "dispatching" }, result);
}

// The caller's heartbeat runs until this returns, so the lease holds through the call.
export async function dispatch(deps: Dispatcher, held: Held, channel: ChannelFacts): Promise<TurnResult> {
  const { kind } = held.claim;
  if (kind === "edit" || kind === "delete") return actionTurn(deps, held, channel, kind);
  // Any other kind than a publish goes to a person with nothing sent.
  if (kind !== "publish") {
    deps.logger.error(
      { operation: held.claim.id, workspace: held.claim.workspaceId, kind: held.claim.kind },
      "operation kind has no worker turn",
    );
    return movedOrLost(held, "needs_human", await move(deps.pool, held, "needs_human"));
  }
  const frozen = await frozenOrFail(deps, held, "claimed");
  if (isTurn(frozen)) return frozen;
  const reply = await replyParent(deps, held, frozen);
  if (isTurn(reply)) return reply;
  if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
  const reader = await mediaReader(deps.pool, held, deps.storage, frozen.alts);
  const prepared = await prepare(deps, held, channel, frozen.text, reader);
  if (isTurn(prepared)) return prepared;
  if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
  const ids = prepared.map((ref) => ref.id);
  return commit(deps, held, channel, frozen.text, { reader, ids }, { ...contentFacts(frozen), ...reply });
}

// A follow-up part answers the post of an earlier part; without that post's remote id there is nothing to answer, and
// nothing was sent.
async function replyParent(
  deps: Dispatcher,
  held: Held,
  frozen: Content,
): Promise<{ replyToExternalId?: string } | TurnResult> {
  if (frozen.replyToPart === null) return {};
  const { rows } = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    tx.query<{ external_id: string | null }>(
      `SELECT external_id FROM app.operations WHERE workspace_id = $1 AND variant_id = $2 AND kind = 'publish'
         AND state = 'published' AND part_index = $3`,
      [held.claim.workspaceId, held.operation.variant_id, frozen.replyToPart],
    ),
  );
  const parent = rows[0]?.external_id;
  if (parent !== null && parent !== undefined) return { replyToExternalId: parent };
  deps.logger.error(
    { operation: held.claim.id, workspace: held.claim.workspaceId, reason: "no_parent_post" },
    "operation has nothing to reply to",
  );
  return movedOrLost(held, "failed", await move(deps.pool, held, "failed"));
}

async function deleteBucket(deps: Dispatcher, held: Held, channel: ChannelFacts): Promise<TurnResult | null> {
  const denied = await takeLimits(deps.pool, held, channel, "delete", () => held.signal.aborted);
  if (held.signal.aborted) return lostTurn(held);
  return denied === null ? null : preflightMove(deps.pool, held, denied);
}

// An edit or a delete acts on the post that the target's publish answered with. It has no prepare step and spends no
// quota of the manifest's send limits; a delete takes its own bucket before the call.
async function actionTurn(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  kind: "edit" | "delete",
): Promise<TurnResult> {
  const frozen = kind === "edit" ? await frozenOrFail(deps, held, "claimed") : undefined;
  if (frozen !== undefined && isTurn(frozen)) return frozen;
  const target = held.operation.target_external_id;
  const send = kind === "edit" ? deps.adapter.edit : deps.adapter.delete;
  if (target === null || send === undefined) {
    deps.logger.error(
      { operation: held.claim.id, workspace: held.claim.workspaceId, kind, reason: "nothing_to_act_on" },
      "operation has nothing to send",
    );
    return movedOrLost(held, "failed", await move(deps.pool, held, "failed"));
  }
  if (deps.closing.aborted) return handBack(deps.pool, held, "handed_back");
  const refused = kind === "delete" ? await deleteBucket(deps, held, channel) : null;
  if (refused !== null) return refused;
  const timeout = timeoutOf(deps, held);
  if (timeout === null) return handBack(deps.pool, held, "handed_back");
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "commit", quotas: {} }),
  );
  if (started.outcome !== "started") return lostTurn(held);
  const post = { externalId: target, account: deps.account };
  const context = contextFor(deps, held, timeout);
  const result =
    frozen === undefined
      ? await deps.adapter.delete(context, post)
      : await deps.adapter.edit?.(context, post, { text: frozen.text, ...contentFacts(frozen) });
  if (held.signal.aborted || result === undefined) return lostTurn(held);
  return settle(deps, held, channel, { id: started.attemptId, from: "dispatching" }, result);
}

type Content = Exclude<Frozen, { reason: string }>;
const contentFacts = (frozen: Content): Pick<CommitInput, "settings" | "locale"> => ({
  settings: frozen.settings,
  locale: frozen.locale,
});

// The log line names the ids and the reason, never the post text.
async function frozenOrFail(deps: Dispatcher, held: Held, from: Source): Promise<Content | TurnResult> {
  const frozen = await frozenFacts(deps.pool, held);
  if (!("reason" in frozen)) return frozen;
  deps.logger.error(
    { operation: held.claim.id, workspace: held.claim.workspaceId, reason: frozen.reason },
    "operation has nothing to send",
  );
  return movedOrLost(held, "failed", await move(deps.pool, held, "failed", {}, from));
}

// The send of a processing operation whose media are all ready: the commit start moves it on to `dispatching`.
export async function sendReady(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  ids: readonly string[],
): Promise<TurnResult> {
  const frozen = await frozenOrFail(deps, held, "processing");
  if (isTurn(frozen)) return frozen;
  const reader = await mediaReader(deps.pool, held, deps.storage, frozen.alts);
  return commit(deps, held, channel, frozen.text, { reader, ids }, contentFacts(frozen), "processing");
}
