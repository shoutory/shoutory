import {
  type Claim,
  claimReconciles,
  finishAttempt,
  recordAbsent,
  startAttempt,
} from "@shoutory/core/ledger/client";
import { backoffSeconds, type CallResult } from "@shoutory/core/ledger/dispatch";
import {
  planReconcile,
  type ReadBackOutcome,
  type ReconcileFacts,
  readBackOutcome,
} from "@shoutory/core/ledger/reconcile";
import type { TenantTx } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap, ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import type { CredentialService } from "../../channels/credentials.js";
import type { Logger } from "../../logging/logger.js";
import { accessOf } from "./account.js";
import { type Caller, call, contextFor, timeoutOf } from "./dispatch.js";
import { hold } from "./heartbeat.js";
import { fencedMove, type Held, inJob, readOperation, sqlOf } from "./held.js";

// One tick reconciles at most this many rows of a provider, so one tick never holds the worker for ever.
const BATCH = 5;
const ALL_KINDS = ["publish", "edit", "delete", "reply"];

export interface ReconcileOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly adapters: AdapterMap;
  readonly fetchFor: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly credentials: CredentialService;
  readonly owner: string;
  readonly closing: AbortSignal;
  readonly now?: () => number;
  readonly clock?: () => Date;
}

const factsOf = (manifest: Manifest): ReconcileFacts => ({
  readBackMode: manifest.readBackMode,
  resendAfterUnknown: manifest.idempotency.resendAfterUnknown,
  keyWindowSeconds: manifest.idempotency.keyWindowSeconds,
  maxInFlightSeconds: manifest.maxInFlightSeconds,
  readBackGapSeconds: manifest.readBackGapSeconds,
  absentAnswers: manifest.absentAnswers,
});

// Providers run side by side, so a read-back that hangs in one never delays another; a failure that is not a row's own
// (the database) is thrown once every provider has finished.
export async function reconcileStep(options: ReconcileOptions): Promise<void> {
  const runs = options.registry.manifests.flatMap((manifest) => {
    const adapter = options.adapters[manifest.id];
    if (adapter === undefined && manifest.readBackMode !== "E") return [];
    return [readBackProvider(options, manifest, adapter)];
  });
  const failed = (await Promise.allSettled(runs)).find((run) => run.status === "rejected");
  if (failed !== undefined) throw failed.reason;
}

async function readBackProvider(
  options: ReconcileOptions,
  manifest: Manifest,
  adapter: ProviderAdapter | undefined,
): Promise<void> {
  const human = manifest.readBackMode === "E";
  const claim = (limit: number) =>
    withSystem(options.pool, "ledger", (tx) =>
      claimReconciles(sqlOf(tx), {
        queue: options.registry.queueNames(manifest.id).reconcile,
        limit,
        owner: options.owner,
        leaseSeconds: manifest.leaseSeconds.readBack,
        classEKinds: human ? ALL_KINDS : [],
      }),
    );
  // A provider that cannot read back hands every due row to a person at once: no lease is taken.
  if (human || adapter === undefined) {
    await claim(BATCH);
    return;
  }
  // One row at a time, so a row's lease starts when its turn does and a closing worker claims nothing more.
  for (let turns = 0; turns < BATCH && !options.closing.aborted; turns++) {
    // The clock starts before the claim, so the heartbeat never counts the lease as ending later than the database does.
    const began = (options.now ?? (() => performance.now()))();
    const [next] = await claim(1);
    if (next === undefined) return;
    await isolated(options, manifest, next, () => reconcileClaim(options, manifest, adapter, next, began));
  }
}

// Ids only: the error text may carry what the provider answered. The row keeps its lease and the lease sweep takes it
// back, so it is never failed or resent here.
async function isolated(
  options: ReconcileOptions,
  manifest: Manifest,
  claim: Claim,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const kind = error instanceof Error ? error.name : "NonError";
    options.logger.error({ provider: manifest.id, operation: claim.id, error: kind }, "read-back failed");
  }
}

async function reconcileClaim(
  options: ReconcileOptions,
  manifest: Manifest,
  adapter: ProviderAdapter,
  claim: Claim,
  started: number,
): Promise<void> {
  const { pool, now = () => performance.now() } = options;
  const operation = await readOperation(pool, claim);
  const holding = hold({
    pool,
    logger: options.logger,
    claim,
    operation,
    manifest,
    leaseSeconds: manifest.leaseSeconds.readBack,
    owner: options.owner,
    now,
    started,
  });
  try {
    const host = await options.credentials.instanceHostOf(operation.workspace_id, operation.channel_id);
    const access = await accessOf(options.credentials, operation, host);
    if (holding.held.signal.aborted) return;
    if (access.kind !== "ok") return await withoutAccess(options, holding.held, access.kind);
    const fetchOf = options.fetchFor(manifest, host);
    const deps: Caller = {
      pool,
      logger: options.logger,
      owner: options.owner,
      adapter,
      fetch: fetchOf,
      account: access.account,
      credentials: options.credentials,
      now,
      clock: options.clock ?? (() => new Date()),
    };
    await reconcileHeld(deps, holding.held);
  } finally {
    await holding.stop();
  }
}

// A revoked grant waits for a reconnect and a passing failure is read again later. A credential that cannot be
// opened will not open by itself, so that row goes to a person instead of waiting for ever.
async function withoutAccess(
  options: ReconcileOptions,
  held: Held,
  kind: "retry" | "revoked" | "unavailable",
): Promise<void> {
  if (kind === "revoked") {
    await inJob(options.pool, held.claim.workspaceId, (tx) => toReconnect(tx, held));
    return;
  }
  options.logger.error(
    { event: "credential_unusable", operation: held.claim.id, workspace: held.claim.workspaceId, kind },
    "no usable credential to read back",
  );
  if (kind === "retry") return park(options.pool, held, backoffSeconds(1));
  return toPerson(options.pool, held, "credential_unavailable");
}

interface History {
  readonly external_id: string | null;
  readonly first_effect_ago: number | null;
  readonly last_effect_ago: number | null;
  readonly absent_reads: number;
  readonly since_absent: number | null;
}

// The key window counts from the first send; the read-back id and the absence rule count from the latest send, so an
// absence read before a resend never counts for the cycle after it.
async function readHistory(pool: AppPool, held: Held): Promise<History> {
  const { rows } = await inJob(pool, held.claim.workspaceId, (tx) =>
    tx.query<History>(
      `WITH sends AS (
         SELECT attempt_no, effect_started_at, response_excerpt FROM app.operation_attempts
          WHERE operation_id = $1 AND step = 'commit'),
       latest AS (SELECT * FROM sends ORDER BY attempt_no DESC LIMIT 1),
       absent AS (
         SELECT a.finished_at FROM app.operation_attempts a
          WHERE a.operation_id = $1 AND a.step = 'read_back' AND a.error_class = 'absent'
            AND a.attempt_no > coalesce((SELECT attempt_no FROM latest), 0))
       SELECT (SELECT response_excerpt FROM latest) AS external_id,
         extract(epoch FROM clock_timestamp() - (SELECT min(effect_started_at) FROM sends))::float8 AS first_effect_ago,
         extract(epoch FROM clock_timestamp() - (SELECT effect_started_at FROM latest))::float8 AS last_effect_ago,
         (SELECT count(*)::int FROM absent) AS absent_reads,
         extract(epoch FROM clock_timestamp() - (SELECT max(finished_at) FROM absent))::float8 AS since_absent`,
      [held.claim.id],
    ),
  );
  if (rows[0] === undefined) throw new Error("the claimed operation cannot be read");
  return rows[0];
}

async function park(pool: AppPool, held: Held, seconds: number): Promise<void> {
  await inJob(pool, held.claim.workspaceId, (tx) =>
    fencedMove(tx, held, "reconciling", "unknown_external_state", { checkInSeconds: seconds }, "R"),
  );
}

interface Asked {
  readonly attemptId: string;
  readonly result: CallResult;
  readonly outcome: ReadBackOutcome;
}

async function ask(
  deps: Caller,
  held: Held,
  externalId: string,
  history: History,
  timeout: number,
): Promise<Asked | null> {
  const started = await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    startAttempt(sqlOf(tx), { ...call(deps, held), step: "read_back" }),
  );
  if (started.outcome !== "started") return null;
  const result: CallResult = await deps.adapter.readBack(contextFor(deps, held, timeout), {
    externalId,
    account: deps.account,
  });
  if (held.signal.aborted) return null;
  const outcome = readBackOutcome(result, factsOf(held.manifest), {
    lastEffectAgoSeconds: history.last_effect_ago ?? Number.POSITIVE_INFINITY,
    absentReads: history.absent_reads,
    secondsSinceAbsentRead: history.since_absent ?? 0,
  });
  return { attemptId: started.attemptId, result, outcome };
}

async function toPerson(pool: AppPool, held: Held, reasonCode: string | undefined): Promise<void> {
  const changes = reasonCode === undefined ? {} : { reasonCode };
  await inJob(pool, held.claim.workspaceId, (tx) =>
    fencedMove(tx, held, "reconciling", "needs_human", changes, "R"),
  );
}

// The next publish turn re-reads the target, takes the limits and marks the effect like any other send.
async function resend(deps: Caller, held: Held): Promise<void> {
  await inJob(deps.pool, held.claim.workspaceId, (tx) =>
    fencedMove(tx, held, "reconciling", "retry_wait", { waitSeconds: 0, idempotentResend: true }, "R"),
  );
}

async function reconcileHeld(deps: Caller, held: Held): Promise<void> {
  const history = await readHistory(deps.pool, held);
  // A row with no committing attempt has no key whose window could be open: it is only ever read back.
  const plan = planReconcile(factsOf(held.manifest), {
    externalId: history.external_id ?? undefined,
    firstEffectAgoSeconds: history.first_effect_ago ?? Number.POSITIVE_INFINITY,
    reads: history.absent_reads,
  });
  if (plan.kind === "resend") return resend(deps, held);
  if (plan.kind === "needs_human") return toPerson(deps.pool, held, plan.reason);
  const timeout = timeoutOf(deps, held);
  const wait = plan.kind === "wait" ? plan.checkInSeconds : backoffSeconds(history.absent_reads + 1);
  if (plan.kind !== "read_back" || timeout === null) return park(deps.pool, held, wait);
  const asked = await ask(deps, held, plan.externalId, history, timeout);
  if (asked === null) return;
  // A refused grant is checked again first: a confirmed revocation holds the row for a reconnect instead of reading on.
  const revoked =
    asked.result.errorClass === "auth_revoked" &&
    (await deps.credentials.confirmRevoked(held.claim.workspaceId, held.operation.channel_id));
  if (held.signal.aborted) return;
  await settle(deps, held, asked, history, plan.externalId, revoked);
}

const BLOCKED = ["needs_reconnect", "disconnected", "revoked_by_provider"];

// A revocation has moved the channel unless a disable moved it first; a row whose channel is not waiting for a reconnect
// is read back again later.
async function toReconnect(tx: TenantTx, held: Held): Promise<void> {
  const channel = await tx.query<{ connection_state: string }>(
    "SELECT connection_state FROM app.channels WHERE id = $1",
    [held.operation.channel_id],
  );
  if (BLOCKED.includes(channel.rows[0]?.connection_state ?? ""))
    await fencedMove(tx, held, "reconciling", "blocked_reconnect", {}, "R");
  else
    await fencedMove(
      tx,
      held,
      "reconciling",
      "unknown_external_state",
      { checkInSeconds: backoffSeconds(1) },
      "R",
    );
}

// One transaction, so a crash cannot leave a finished attempt without its move. Nothing is written when the lease is lost.
async function settle(
  deps: Caller,
  held: Held,
  { attemptId, result, outcome }: Asked,
  history: History,
  externalId: string | undefined,
  revoked: boolean,
): Promise<void> {
  const absent = ["absent_once", "absent_proven", "needs_human"].includes(outcome.kind);
  const errorClass = absent ? "absent" : result.errorClass;
  await inJob(deps.pool, held.claim.workspaceId, async (tx) => {
    const finished = await finishAttempt(sqlOf(tx), {
      workspaceId: held.claim.workspaceId,
      attemptId,
      token: held.claim.fencingToken,
      result: {
        effect: outcome.kind === "published" ? "confirmed" : "possible",
        ...(result.httpStatus === undefined ? {} : { http_status: result.httpStatus }),
        ...(errorClass === undefined ? {} : { error_class: errorClass }),
      },
    });
    if (finished !== "finished") return;
    if (revoked) await toReconnect(tx, held);
    else await moveFor(tx, held, outcome, history, externalId);
  });
}

async function moveFor(
  tx: TenantTx,
  held: Held,
  outcome: ReadBackOutcome,
  history: History,
  externalId: string | undefined,
): Promise<void> {
  if (outcome.kind === "published")
    await fencedMove(tx, held, "reconciling", "published", { evidence: outcome.evidence }, "R");
  else if (outcome.kind === "needs_human") await fencedMove(tx, held, "reconciling", "needs_human", {}, "R");
  else if (outcome.kind === "absent_proven" && externalId !== undefined) {
    const { workspaceId, id } = held.claim;
    await recordAbsent(sqlOf(tx), { workspaceId, operationId: id, externalId });
    await fencedMove(tx, held, "reconciling", "retry_wait", { waitSeconds: 0 }, "R");
  } else {
    const checkInSeconds = backoffSeconds(history.absent_reads + 1);
    await fencedMove(tx, held, "reconciling", "unknown_external_state", { checkInSeconds }, "R");
  }
}
