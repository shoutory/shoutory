import { claimPolls, recordProgress, rereadOutcome } from "@shoutory/core/ledger/client";
import { pollMove } from "@shoutory/core/ledger/dispatch";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import { accessOf } from "./account.js";
import {
  call,
  contextFor,
  type Dispatcher,
  quotaDenied,
  refsSchema,
  sendReady,
  timeoutOf,
} from "./dispatch.js";
import { hold } from "./heartbeat.js";
import { type ChannelFacts, type Held, inJob, move, readOperation, sqlOf, takeLimits } from "./held.js";
import { readTarget, type TurnOptions } from "./turn.js";

// One pass polls at most this many rows of a provider, so one pass never holds the worker for ever.
const BATCH = 5;

type PollOptions = Omit<TurnOptions, "queue">;

// Providers run side by side, so a poll that hangs in one never delays another; a failure that is not a row's own
// (the database) is thrown once every provider has finished.
export async function pollStep(options: PollOptions): Promise<void> {
  const runs = options.registry.manifests.flatMap((manifest) => {
    const adapter = options.adapters[manifest.id];
    return adapter?.pollMedia === undefined ? [] : [pollProvider(options, manifest, adapter)];
  });
  const failed = (await Promise.allSettled(runs)).find((run) => run.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

async function pollProvider(
  options: PollOptions,
  manifest: Manifest,
  adapter: ProviderAdapter,
): Promise<void> {
  const queue = options.registry.queueNames(manifest.id).publish;
  // One row at a time, so a row's lease starts when its turn does and a closing worker claims nothing more.
  for (let turns = 0; turns < BATCH && !options.closing.aborted; turns++) {
    // The clock starts before the claim, so the heartbeat never counts the lease as ending later than the database does.
    const began = (options.now ?? (() => performance.now()))();
    const [next] = await withSystem(options.pool, "ledger", (tx) =>
      claimPolls(sqlOf(tx), {
        queue,
        limit: 1,
        owner: options.owner,
        leaseSeconds: manifest.leaseSeconds.commit,
      }),
    );
    if (next === undefined) return;
    // A row that is not processing is left to its lease.
    if (next.state !== "processing") continue;
    await isolated(options, manifest, next.id, async () => {
      const operation = await readOperation(options.pool, next);
      const holding = hold({
        pool: options.pool,
        logger: options.logger,
        claim: next,
        operation,
        manifest,
        leaseSeconds: manifest.leaseSeconds.commit,
        owner: options.owner,
        now: options.now ?? (() => performance.now()),
        started: began,
      });
      try {
        await pollHeld(options, manifest, adapter, holding.held);
      } finally {
        await holding.stop();
      }
    });
  }
}

// Ids only: the error text may carry what the provider answered. The row keeps its lease and the lease sweep takes it
// back, so a failure here never fails or resends anything.
async function isolated(
  options: PollOptions,
  manifest: Manifest,
  operation: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const kind = error instanceof Error ? error.name : "NonError";
    options.logger.error({ provider: manifest.id, operation, error: kind }, "media poll failed");
  }
}

async function deadlineLeft(options: PollOptions, held: Held): Promise<number | null> {
  const { rows } = await inJob(options.pool, held.claim.workspaceId, (tx) =>
    tx.query<{ left: number | null }>(
      "SELECT extract(epoch FROM processing_deadline - clock_timestamp())::float8 AS left FROM app.operations WHERE id = $1",
      [held.claim.id],
    ),
  );
  return rows[0]?.left ?? null;
}

// A passed deadline ends the wait without asking the provider: back to retry_wait while attempts remain, else failed.
// The timeout counts as an attempt, so the last attempt left fails.
async function endWait(options: PollOptions, held: Held, manifest: Manifest): Promise<void> {
  const spent = held.operation.attempt_count + 1 >= manifest.maxAttempts;
  if (spent) await move(options.pool, held, "failed", {}, "processing");
  else await move(options.pool, held, "retry_wait", { waitSeconds: 0 }, "processing");
}

async function pollHeld(
  options: PollOptions,
  manifest: Manifest,
  adapter: ProviderAdapter,
  held: Held,
): Promise<void> {
  const { pool, closing, now = () => performance.now() } = options;
  const left = await deadlineLeft(options, held);
  if (held.signal.aborted) return;
  if (left !== null && left <= 0) return endWait(options, held, manifest);
  // A row that cannot be polled now is checked again later, so it is not claimed on every tick; once its deadline has
  // passed the publish turn settles it.
  const later = () => checkLater(pool, held, manifest.readBackGapSeconds);
  const target = await readTarget(pool, held.operation);
  const { channel } = target;
  if (held.signal.aborted) return;
  if (
    channel === undefined ||
    rereadOutcome({ channelState: channel.connection_state, targetLive: target.targetLive }) !== null
  )
    return later();
  const access = await accessOf(options.credentials, held.operation, channel.instance_host);
  if (held.signal.aborted) return;
  if (access.kind !== "ok") {
    options.logger.error(
      {
        event: "credential_unusable",
        operation: held.claim.id,
        workspace: held.claim.workspaceId,
        kind: access.kind,
      },
      "no usable credential to poll media",
    );
    return later();
  }
  const deps: Dispatcher = {
    pool,
    logger: options.logger,
    owner: options.owner,
    adapter,
    fetch: options.fetchFor(manifest, channel.instance_host ?? undefined),
    account: access.account,
    credentials: options.credentials,
    now,
    clock: options.clock ?? (() => new Date()),
    reconcileQueue: options.registry.queueNames(manifest.id).reconcile,
    closing,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  };
  await poll(deps, manifest, held, channel);
}

const checkLater = (pool: AppPool, held: Held, seconds: number) =>
  inJob(pool, held.claim.workspaceId, (tx) =>
    recordProgress(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      operationId: held.claim.id,
      token: held.claim.fencingToken,
      pollInSeconds: seconds,
    }),
  ).then(() => undefined);

// A refused grant is confirmed before the row is held: only a channel that is now waiting for a reconnect holds it, any
// other answer is checked again later.
async function revoked(deps: Dispatcher, manifest: Manifest, held: Held): Promise<void> {
  await deps.credentials.confirmRevoked(held.claim.workspaceId, held.operation.channel_id);
  if (held.signal.aborted) return;
  const target = await readTarget(deps.pool, held.operation);
  const state = target.channel?.connection_state;
  if (
    state !== undefined &&
    rereadOutcome({ channelState: state, targetLive: target.targetLive })?.to === "blocked_reconnect"
  )
    await move(deps.pool, held, "blocked_reconnect", {}, "processing");
  else await checkLater(deps.pool, held, manifest.readBackGapSeconds);
}

async function poll(deps: Dispatcher, manifest: Manifest, held: Held, channel: ChannelFacts): Promise<void> {
  const timeout = timeoutOf(deps, held);
  if (timeout === null || deps.adapter.pollMedia === undefined)
    return checkLater(deps.pool, held, manifest.readBackGapSeconds);
  const refs = refsSchema.parse(held.operation.provider_refs ?? {}).media;
  const result = await deps.adapter.pollMedia(contextFor(deps, held, timeout), {
    mediaIds: refs.filter((ref) => ref.processing).map((ref) => ref.id),
    account: deps.account,
  });
  if (held.signal.aborted) return;
  const next = pollMove(result, {
    gapSeconds: manifest.readBackGapSeconds,
    retryAfterMaxSeconds: manifest.retryAfterMaxSeconds,
  });
  if (next.row === 14)
    return ready(
      deps,
      held,
      channel,
      refs.map((ref) => ref.id),
    );
  if (next.row === 13) return revoked(deps, manifest, held);
  if (next.row === 16) return rejected(deps, held);
  await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    recordProgress(sqlOf(tx), { ...call(deps, held), pollInSeconds: next.checkInSeconds }),
  );
}

// Every medium is ready: the cursor reaches `commit` first, so a later resend never polls again, and the send runs the
// commit start like the publish turn does.
async function ready(
  deps: Dispatcher,
  held: Held,
  channel: ChannelFacts,
  ids: readonly string[],
): Promise<void> {
  // No lateness left means nothing may be sent: the row goes back to retry_wait and the due-move sweep ends it missed.
  if (held.operation.lateness_left_seconds <= 0) {
    await move(deps.pool, held, "retry_wait", { waitSeconds: 0 }, "processing");
    return;
  }
  const settled = ids.map((id) => ({ id, processing: false }));
  const recorded = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    recordProgress(sqlOf(tx), { ...call(deps, held), cursor: "commit", refs: { media: settled } }),
  );
  if (recorded !== "recorded") return;
  const denied = await takeLimits(
    deps.pool,
    held,
    channel,
    "turn",
    () => held.signal.aborted || deps.closing.aborted,
  );
  if (held.signal.aborted) return;
  if (denied !== null) {
    await quotaDenied(deps, held, "waitSeconds" in denied ? (denied.waitSeconds ?? 1) : 1, "processing");
    return;
  }
  await sendReady(deps, held, channel, ids);
}

// Ids only: what the provider said about a medium is never logged.
async function rejected(deps: Dispatcher, held: Held): Promise<void> {
  deps.logger.error(
    { operation: held.claim.id, workspace: held.claim.workspaceId },
    "the provider rejected a medium",
  );
  await move(deps.pool, held, "failed", {}, "processing");
}
