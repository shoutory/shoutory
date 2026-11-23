import { createHash } from "node:crypto";
import { z } from "zod";

// The worker's side of the ledger: typed calls and answers for the SQL definers, and the small rules the worker applies
// around them. It does no I/O: the SQL runner is an argument.

/** Runs one statement and answers its rows. */
type SqlRun = (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** The channel column that each key name of a manifest rate limit reads. A name outside this table is refused. */
export const BUCKET_KEY_COLUMNS = {
  app: "provider_id",
  account: "provider_account_id",
  chat: "provider_account_id",
  webhook: "provider_account_id",
  instance: "instance_host",
} as const;
export type BucketKeyName = keyof typeof BUCKET_KEY_COLUMNS;
export const BUCKET_KEY_NAMES = Object.keys(BUCKET_KEY_COLUMNS) as [BucketKeyName, ...BucketKeyName[]];

interface ChannelColumns {
  provider_id: string;
  provider_account_id: string | null;
  instance_host: string | null;
}

/**
 * The key of a rate bucket: a digest of the provider, the limit name, the scope and the value of the channel column, so two
 * accounts of one provider never share a bucket and two limits of one account never share one. A null column is refused.
 */
export function bucketKey(input: {
  limitName: string;
  scope: string;
  keyName: BucketKeyName;
  channel: ChannelColumns;
}): string {
  const column = BUCKET_KEY_COLUMNS[input.keyName];
  const value = column === undefined ? undefined : input.channel[column];
  if (value === undefined || value === null)
    throw new Error(`the channel has no value for the bucket key ${input.keyName}`);
  return createHash("sha256")
    .update([input.channel.provider_id, input.limitName, input.scope, value].join("\0"))
    .digest("hex");
}

const SAFETY_MARGIN_MS = 10_000;
/**
 * The timeout of one provider call: the manifest's, or what is left of the lease minus 10 seconds when that is less. The
 * time since the claim comes from a monotonic clock the caller started before the claim; with no time left it is null
 * and no call is made.
 */
export function callTimeoutMs(input: {
  manifestTimeoutMs: number;
  leaseSeconds: number;
  elapsedMs: number;
}): number | null {
  const room = input.leaseSeconds * 1000 - input.elapsedMs - SAFETY_MARGIN_MS;
  return room <= 0 ? null : Math.min(input.manifestTimeoutMs, room);
}

/** A publish is claimed with the longer of the prepare and the commit lease. */
export const publishLeaseSeconds = (lease: { prepare: number; commit: number }): number =>
  Math.max(lease.prepare, lease.commit);

interface ProviderFacts {
  id: string;
  dispatchMarginSeconds: number;
  leaseSeconds: { prepare: number; commit: number; edit?: number | undefined; delete?: number | undefined };
}
/** The providers argument of admission: an action the manifest does not have is left out. */
export function providersArgument(facts: readonly ProviderFacts[]): Record<string, unknown> {
  return Object.fromEntries(
    facts.map(({ id, dispatchMarginSeconds, leaseSeconds: lease }) => [
      id,
      {
        margin_seconds: dispatchMarginSeconds,
        lease_seconds: {
          publish: publishLeaseSeconds(lease),
          ...(lease.edit === undefined ? {} : { edit: lease.edit }),
          ...(lease.delete === undefined ? {} : { delete: lease.delete }),
        },
      },
    ]),
  );
}

interface SweepFacts {
  id: string;
  readBackMode: string;
  maxAttempts: number;
  unverifiedHorizonDays: number;
  /** False for a provider whose API has retired at the time of the tick. */
  live: boolean;
}
/**
 * The arguments of the two sweeps, from the manifests: for the lease sweep, how soon a row that became unknown is first
 * read back (at once for a provider that cannot read back) and how long it is chased; for the due-move sweep, the
 * attempts a row may use, and only for a live provider: one whose API has retired is left out, so its `api_sunset` pauses
 * stay and its retry and unknown rows wait until a live version is named. A provider not listed is not touched
 * by the rules that need its manifest.
 */
export function sweepArguments(facts: readonly SweepFacts[]): {
  leases: Record<string, unknown>;
  due: Record<string, unknown>;
} {
  return {
    leases: Object.fromEntries(
      facts.map((fact) => [
        fact.id,
        {
          first_backoff_seconds: fact.readBackMode === "E" ? 0 : 60,
          unverified_horizon_days: fact.unverifiedHorizonDays,
        },
      ]),
    ),
    due: Object.fromEntries(
      facts.filter((fact) => fact.live).map((fact) => [fact.id, { max_attempts: fact.maxAttempts }]),
    ),
  };
}

export type PreflightMove =
  | {
      to: "paused";
      reasonCode: "channel_disabled" | "provider_cooldown" | "api_sunset";
      waitSeconds?: number;
    }
  | { to: "retry_wait"; waitSeconds: number }
  | { to: "blocked_reconnect" }
  | { to: "failed" };

/**
 * What the worker does when it has claimed an operation and reads its channel and its target again: a target that is gone
 * or settled fails the operation; a disabled channel pauses it; a channel that lost its grant parks it until the owner
 * reconnects (OL row 13, which only the channel states `needs_reconnect`, `disconnected` and `revoked_by_provider` allow).
 */
export function rereadOutcome(input: { channelState: string; targetLive: boolean }): PreflightMove | null {
  if (!input.targetLive) return { to: "failed" };
  if (input.channelState === "disabled") return { to: "paused", reasonCode: "channel_disabled" };
  if (input.channelState !== "connected") return { to: "blocked_reconnect" };
  return null;
}

/**
 * What the worker does when a rate bucket denies it: wait for the retry when that fits the manifest's maximum and what is
 * left of the lateness window, else pause the operation with a provider cooldown. Either way it is due again after the wait,
 * which is at least a second so a bucket that answers zero never makes the row due at once.
 */
export function denialMove(input: {
  retryAfterSeconds: number;
  retryAfterMaxSeconds: number;
  latenessLeftSeconds: number;
}): PreflightMove {
  const waitSeconds = Math.max(1, input.retryAfterSeconds);
  const fits = waitSeconds <= Math.min(input.retryAfterMaxSeconds, input.latenessLeftSeconds);
  return fits
    ? { to: "retry_wait", waitSeconds }
    : { to: "paused", reasonCode: "provider_cooldown", waitSeconds };
}

// The keys a fenced move may change (the SQL refuses any other).
export const transitionChangesSchema = z.strictObject({
  reason_code: z.string().optional(),
  next_attempt_at: z.string().optional(),
  next_check_at: z.string().optional(),
  poll_deadline: z.string().optional(),
  processing_deadline: z.string().optional(),
  step_cursor: z.string().optional(),
  provider_refs: z.record(z.string(), z.unknown()).optional(),
  queue: z.string().optional(),
  external_id: z.string().optional(),
  lease_expires_at: z.string().optional(),
  heartbeat_at: z.string().optional(),
  evidence: z.unknown().optional(),
  idempotent_resend: z.boolean().optional(),
  unverified_horizon_days: z.number().int().optional(),
});

export interface TransitionCall {
  workspaceId: string;
  operationId: string;
  token: string | number;
  from: string;
  to: string;
  actor: "W" | "P" | "R";
  changes?: z.input<typeof transitionChangesSchema>;
  /** The next attempt and the next check, in seconds from now on the database clock, set in the move's own statement. */
  attemptInSeconds?: number;
  checkInSeconds?: number;
}
export type TransitionResult = { outcome: "moved"; fencingToken: string } | { outcome: "lost_lease" };

/** One fenced move; a move whose token or state is no longer the caller's answers `lost_lease`, never an error. */
export async function transition(run: SqlRun, call: TransitionCall): Promise<TransitionResult> {
  const changes = transitionChangesSchema.parse(call.changes ?? {});
  const { rows } = await run(
    `SELECT * FROM app.operation_transition($1, $2, $3, $4, $5, $6, $7::jsonb
       || CASE WHEN $8::float8 IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('next_attempt_at', (clock_timestamp() + make_interval(secs => $8::float8))::text) END
       || CASE WHEN $9::float8 IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('next_check_at', (clock_timestamp() + make_interval(secs => $9::float8))::text) END)`,
    [
      call.workspaceId,
      call.operationId,
      String(call.token),
      call.from,
      call.to,
      call.actor,
      JSON.stringify(changes),
      call.attemptInSeconds ?? null,
      call.checkInSeconds ?? null,
    ],
  );
  const row = rows[0];
  if (row?.outcome === "lost_lease") return { outcome: "lost_lease" };
  if (row?.outcome === "moved") return { outcome: "moved", fencingToken: String(row.fencing_token) };
  throw new Error("operation_transition answered neither moved nor lost_lease");
}

const claimRow = z.object({
  id: z.string(),
  workspace_id: z.string(),
  fencing_token: z.union([z.string(), z.number(), z.bigint()]).transform(String),
  lease_expires_at: z.date(),
  kind: z.string(),
  state: z.string(),
});
export type Claim = { id: string; workspaceId: string; fencingToken: string; kind: string; state: string };

/** Claims one due operation of a queue for `owner`, or null when none is due. */
export async function claimOperation(run: SqlRun, queue: string, owner: string): Promise<Claim | null> {
  const { rows } = await run("SELECT * FROM app.claim_operations($1, 1, $2)", [queue, owner]);
  if (rows[0] === undefined) return null;
  const row = claimRow.parse(rows[0]);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fencingToken: row.fencing_token,
    kind: row.kind,
    state: row.state,
  };
}

/**
 * Claims up to `limit` unknown outcomes of a reconcile queue that are due. A kind in `classEKinds` goes to a person at once
 * (the provider cannot read back); every other row becomes `reconciling` under a lease for `owner`.
 */
export async function claimReconciles(
  run: SqlRun,
  call: { queue: string; limit: number; owner: string; leaseSeconds: number; classEKinds: readonly string[] },
): Promise<Claim[]> {
  const { rows } = await run("SELECT * FROM app.claim_reconciles($1, $2, $3, $4, $5::text[])", [
    call.queue,
    call.limit,
    call.owner,
    call.leaseSeconds,
    call.classEKinds,
  ]);
  // A row handed to a person has no lease: only the leased rows are parsed and returned.
  return rows
    .filter((row) => row.state === "reconciling")
    .map((row) => claimRow.parse(row))
    .map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      fencingToken: row.fencing_token,
      kind: row.kind,
      state: row.state,
    }));
}

/** Records that a read-back proved the post absent; the evidence a move back to retry needs (OL 7.3). */
export async function recordAbsent(
  run: SqlRun,
  call: { workspaceId: string; operationId: string; externalId: string },
): Promise<void> {
  await run("SELECT * FROM app.record_evidence($1, $2, 'absent', 'read_back', NULL, $3::jsonb)", [
    call.workspaceId,
    call.operationId,
    JSON.stringify({ source: "adapter", external_id: call.externalId }),
  ]);
}

/** Extends the lease the caller holds by `extendSeconds`; `lost` when it no longer holds it. */
export async function heartbeat(
  run: SqlRun,
  call: { id: string; token: string; owner: string; extendSeconds: number },
): Promise<"ok" | "lost"> {
  const { rows } = await run("SELECT * FROM app.heartbeat($1, $2, $3, $4)", [
    call.id,
    call.token,
    call.owner,
    call.extendSeconds,
  ]);
  return rows[0]?.outcome === "ok" ? "ok" : "lost";
}

export type AttemptStep = "prepare" | "commit" | "poll" | "read_back";
export type AttemptStart =
  | { outcome: "started"; attemptId: string; attemptNo: number }
  | { outcome: "lost_lease" }
  | { outcome: "quota_denied" };

/**
 * Starts one step of an attempt. A `commit` start is the effect marker: it moves the row to dispatching with the effect
 * `possible` and takes the manifest's quotas, all in the caller's transaction, which must commit before the provider is called.
 */
export async function startAttempt(
  run: SqlRun,
  call: {
    workspaceId: string;
    operationId: string;
    token: string;
    owner: string;
    step: AttemptStep;
    quotas?: Record<string, { capacity: number; window_seconds: number }>;
  },
): Promise<AttemptStart> {
  const { rows } = await run("SELECT * FROM app.operation_attempt_start($1, $2, $3, $4, $5, $6::jsonb)", [
    call.workspaceId,
    call.operationId,
    call.token,
    call.owner,
    call.step,
    JSON.stringify(call.quotas ?? {}),
  ]);
  const row = rows[0];
  if (row?.outcome === "started")
    return { outcome: "started", attemptId: String(row.attempt_id), attemptNo: Number(row.attempt_no) };
  if (row?.outcome === "lost_lease") return { outcome: "lost_lease" };
  if (row?.outcome === "quota_denied") return { outcome: "quota_denied" };
  throw new Error("operation_attempt_start answered an unknown outcome");
}

export interface AttemptResult {
  effect: "none" | "possible" | "confirmed";
  http_status?: number;
  error_class?: string;
  provider_code?: string;
  retry_after_ms?: number;
  /** The id the provider answered with, kept on the attempt. */
  response_excerpt?: string;
}

/** Writes what an attempt did, once; `lost_lease` when the token is no longer the caller's. */
export async function finishAttempt(
  run: SqlRun,
  call: { workspaceId: string; attemptId: string; token: string; result: AttemptResult },
): Promise<"finished" | "lost_lease"> {
  const { rows } = await run("SELECT * FROM app.operation_attempt_finish($1, $2, $3, $4::jsonb)", [
    call.workspaceId,
    call.attemptId,
    call.token,
    JSON.stringify(call.result),
  ]);
  return rows[0]?.outcome === "finished" ? "finished" : "lost_lease";
}

/** Records the step a worker has reached, with no move of state. */
export async function recordProgress(
  run: SqlRun,
  call: { workspaceId: string; operationId: string; token: string; cursor: string },
): Promise<"recorded" | "lost_lease"> {
  const { rows } = await run("SELECT * FROM app.operation_record_progress($1, $2, $3, $4, NULL)", [
    call.workspaceId,
    call.operationId,
    call.token,
    call.cursor,
  ]);
  return rows[0]?.outcome === "recorded" ? "recorded" : "lost_lease";
}

export interface BucketAnswer {
  allowed: boolean;
  retryAfterSeconds: number;
}
/** Spends one token of a manifest-scope bucket. */
export async function takeBucket(
  run: SqlRun,
  call: { key: string; scope: string; capacity: number; windowSeconds: number },
): Promise<BucketAnswer> {
  const { rows } = await run("SELECT * FROM app.bucket_take_scoped($1, $2, $3, $4, 1)", [
    call.key,
    call.scope,
    call.capacity,
    call.windowSeconds,
  ]);
  return { allowed: rows[0]?.allowed === true, retryAfterSeconds: Number(rows[0]?.retry_after_seconds ?? 0) };
}
