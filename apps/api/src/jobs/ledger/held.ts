import {
  type Claim,
  type PreflightMove,
  type TransitionResult,
  transition,
} from "@shoutory/core/ledger/client";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";

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
  readonly lateness_left_seconds: number;
}

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
  readonly started: number;
  readonly signal: AbortSignal;
}

export const sqlOf = (tx: TenantTx) => (text: string, values: unknown[]) => tx.query(text, values);
const asJob = (workspaceId: string) =>
  ({ principalKind: "job", jobPurpose: "ledger", workspaceIds: [workspaceId] }) as const;

export const inJob = <T>(pool: AppPool, workspaceId: string, run: (tx: TenantTx) => Promise<T>): Promise<T> =>
  withTenant(pool, asJob(workspaceId), run);

export const refuseEgress = (): typeof fetch => () =>
  Promise.reject(new TypeError("no egress is configured"));

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

// Waits are seconds from now, counted by the database clock, never by this process's clock.
export interface MoveChanges {
  readonly reasonCode?: string;
  readonly waitSeconds?: number;
  readonly checkInSeconds?: number;
  readonly queue?: string;
  readonly horizonDays?: number;
  readonly evidence?: unknown;
  readonly idempotentResend?: boolean;
}

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

export const movedOrLost = (held: Held, to: string, moved: boolean, reason?: string): TurnResult =>
  moved
    ? { kind: "moved", id: held.claim.id, to, ...(reason === undefined ? {} : { reason }) }
    : { kind: "lost", id: held.claim.id };

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

export async function preflightMove(pool: AppPool, held: Held, outcome: PreflightMove): Promise<TurnResult> {
  const changes: { reasonCode?: string; waitSeconds?: number } = {};
  if (outcome.to === "paused") changes.reasonCode = outcome.reasonCode;
  if ("waitSeconds" in outcome && outcome.waitSeconds !== undefined)
    changes.waitSeconds = outcome.waitSeconds;
  const moved = await move(pool, held, outcome.to, changes);
  return movedOrLost(held, outcome.to, moved, outcome.to === "paused" ? outcome.reasonCode : undefined);
}

export async function handBack(
  pool: AppPool,
  held: Held,
  kind: "closed" | "handed_back",
): Promise<TurnResult> {
  return (await move(pool, held, "pending")) ? { kind } : { kind: "lost", id: held.claim.id };
}
