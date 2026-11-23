import { type Claim, type TransitionResult, transition } from "@shoutory/core/ledger/client";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";

// What a worker holds while it works one claimed operation, and the fenced moves it makes with it.

export type TurnResult =
  | { kind: "idle" }
  | { kind: "closed" }
  | { kind: "handed_back" }
  | { kind: "lost"; id: string }
  | { kind: "moved"; id: string; to: string; reason?: string }
  | { kind: "dispatched"; id: string; to: string };

export interface Operation {
  readonly id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly variant_id: string;
  readonly provider_id: string;
  readonly idempotency_marker: string;
  readonly frozen_version_id: string | null;
  readonly attempt_count: number;
  /** What is left of the lateness window, blocked time not counted, as the database counts it. */
  readonly lateness_left_seconds: number;
}

/** The channel of an operation as the worker reads it again after the claim. */
export interface ChannelFacts {
  readonly provider_id: string;
  readonly provider_account_id: string | null;
  readonly instance_host: string | null;
  readonly connection_state: string;
}

export interface Held {
  readonly claim: Claim;
  readonly operation: Operation;
  readonly manifest: Manifest;
  readonly leaseSeconds: number;
  /** Start of the claim on the monotonic clock. */
  readonly started: number;
  /** Aborts when the heartbeat says the lease is lost. */
  readonly signal: AbortSignal;
}

export const sqlOf = (tx: TenantTx) => (text: string, values: unknown[]) => tx.query(text, values);
const asJob = (workspaceId: string) =>
  ({ principalKind: "job", jobPurpose: "ledger", workspaceIds: [workspaceId] }) as const;

/** One transaction as the ledger's job principal of a workspace. */
export const inJob = <T>(pool: AppPool, workspaceId: string, run: (tx: TenantTx) => Promise<T>): Promise<T> =>
  withTenant(pool, asJob(workspaceId), run);

/** A worker started with no network wiring cannot send: every call an adapter makes is refused. */
export const refuseEgress = (): typeof fetch => () =>
  Promise.reject(new TypeError("no egress is configured"));

/** The operation a claim holds, as the database has it now. */
export async function readOperation(pool: AppPool, claim: Claim): Promise<Operation> {
  const { rows } = await inJob(pool, claim.workspaceId, (tx) =>
    tx.query<Operation>(
      `SELECT id, workspace_id, channel_id, variant_id, provider_id, idempotency_marker, frozen_version_id, attempt_count,
              extract(epoch FROM lateness_deadline + blocked_total - clock_timestamp())::float8 AS lateness_left_seconds
         FROM app.operations WHERE id = $1`,
      [claim.id],
    ),
  );
  if (rows[0] === undefined) throw new Error("the claimed operation cannot be read");
  return rows[0];
}

/** What a move changes: waits are seconds from now, counted by the database clock, never by this process's clock. */
export interface MoveChanges {
  readonly reasonCode?: string;
  readonly waitSeconds?: number;
  readonly checkInSeconds?: number;
  readonly queue?: string;
  readonly horizonDays?: number;
  readonly evidence?: unknown;
  /** A move back to retry that sends the post again with its own key (OL 7.2, row 36). */
  readonly idempotentResend?: boolean;
}

/** One fenced move of the held operation inside the caller's transaction (the actor is the worker, or the reconciler). */
export async function fencedMove(
  tx: TenantTx,
  held: Held,
  from: string,
  to: string,
  changes: MoveChanges = {},
  actor: "W" | "R" = "W",
): Promise<TransitionResult> {
  return transition(sqlOf(tx), {
    workspaceId: held.claim.workspaceId,
    operationId: held.claim.id,
    token: held.claim.fencingToken,
    from,
    to,
    actor,
    ...(changes.waitSeconds === undefined ? {} : { attemptInSeconds: changes.waitSeconds }),
    ...(changes.checkInSeconds === undefined ? {} : { checkInSeconds: changes.checkInSeconds }),
    changes: {
      ...(changes.reasonCode === undefined ? {} : { reason_code: changes.reasonCode }),
      ...(changes.queue === undefined ? {} : { queue: changes.queue }),
      ...(changes.horizonDays === undefined ? {} : { unverified_horizon_days: changes.horizonDays }),
      ...(changes.evidence === undefined ? {} : { evidence: changes.evidence }),
      ...(changes.idempotentResend === undefined ? {} : { idempotent_resend: changes.idempotentResend }),
    },
  });
}

/** What a turn answers after a move: the move it made, or `lost` when the lease was no longer its own. */
export const movedOrLost = (held: Held, to: string, moved: boolean, reason?: string): TurnResult =>
  moved
    ? { kind: "moved", id: held.claim.id, to, ...(reason === undefined ? {} : { reason }) }
    : { kind: "lost", id: held.claim.id };

/** Moves the claimed row by one fenced move of the worker out of `claimed`; true when it landed. */
export async function move(
  pool: AppPool,
  held: Held,
  to: string,
  changes: MoveChanges = {},
): Promise<boolean> {
  const result = await inJob(pool, held.claim.workspaceId, (tx) =>
    fencedMove(tx, held, "claimed", to, changes),
  );
  return result.outcome === "moved";
}

/** Gives the claimed row back to the queue (row 10): the worker is closing, or too little lease is left for a call. */
export async function handBack(
  pool: AppPool,
  held: Held,
  kind: "closed" | "handed_back",
): Promise<TurnResult> {
  return (await move(pool, held, "pending")) ? { kind } : { kind: "lost", id: held.claim.id };
}
