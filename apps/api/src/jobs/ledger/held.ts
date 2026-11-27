import {
  bucketKey,
  type Claim,
  denialMove,
  type PreflightMove,
  type TransitionResult,
  takeBucket,
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
  readonly part_index: number;
  readonly provider_id: string;
  readonly idempotency_marker: string;
  readonly frozen_version_id: string | null;
  readonly attempt_count: number;
  readonly lateness_left_seconds: number;
  readonly locale: string | null;
  readonly step_cursor: string | null;
  readonly provider_refs: unknown;
  /** The remote id an edit or delete acts on: the one the publish of its part answered with. */
  readonly target_external_id: string | null;
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
  readonly leaseEnd: () => number;
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
      `SELECT o.id, o.workspace_id, o.channel_id, o.variant_id, o.part_index, o.provider_id, o.idempotency_marker,
              o.frozen_version_id, o.attempt_count, o.step_cursor, o.provider_refs,
              extract(epoch FROM o.lateness_deadline + o.blocked_total - clock_timestamp())::float8 AS lateness_left_seconds,
              (SELECT v.locale FROM app.post_variants v WHERE v.workspace_id = o.workspace_id AND v.id = o.variant_id) AS locale,
              coalesce(
                (SELECT p.external_id FROM app.operations p WHERE p.workspace_id = o.workspace_id
                   AND p.variant_id = o.variant_id AND p.kind = 'publish' AND p.state = 'published'
                   AND p.part_index = o.part_index ORDER BY p.settled_at DESC LIMIT 1),
                CASE WHEN o.part_index = 0 THEN
                  (SELECT v.external_id FROM app.post_variants v WHERE v.workspace_id = o.workspace_id AND v.id = o.variant_id)
                END) AS target_external_id
         FROM app.operations o WHERE o.id = $1`,
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
  readonly processingSeconds?: number;
  readonly stepCursor?: string;
}

export async function fencedMove(
  tx: TenantTx,
  held: Held,
  from: string,
  to: string,
  changes: MoveChanges = {},
  actor: "W" | "P" | "R" = "W",
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
    ...(changes.processingSeconds === undefined ? {} : { processingInSeconds: changes.processingSeconds }),
    changes: {
      ...(changes.stepCursor === undefined ? {} : { step_cursor: changes.stepCursor }),
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

// The turn moves a claimed row as the worker; a poll moves a processing row as the poller.
export async function move(
  pool: AppPool,
  held: Held,
  to: string,
  changes: MoveChanges = {},
  from: "claimed" | "processing" = "claimed",
): Promise<boolean> {
  const result = await inJob(pool, held.claim.workspaceId, (tx) =>
    fencedMove(tx, held, from, to, changes, from === "claimed" ? "W" : "P"),
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

// Takes one token from each limit the event spends, stopping at the first denial; the tokens already taken stay spent, so
// a turn never sends more than the limits allow.
export async function takeLimits(
  pool: AppPool,
  held: Held,
  channel: ChannelFacts,
  spender: "turn" | "upload" | "delete",
  stopped: () => boolean,
): Promise<PreflightMove | null> {
  for (const limit of held.manifest.rateLimits) {
    if (limit.spentBy !== spender) continue;
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
