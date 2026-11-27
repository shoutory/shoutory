import { denialMove } from "./client.js";

// Matches the provider SDK's result without importing it: the core imports no provider package.
export interface CallResult {
  readonly ok: boolean;
  readonly effect: "none" | "possible" | "confirmed";
  readonly externalId?: string | undefined;
  readonly permalink?: string | undefined;
  readonly errorClass?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly absent?: boolean | undefined;
  readonly content?:
    | {
        readonly text: string;
        readonly settings: Readonly<Record<string, string | number | boolean>>;
      }
    | undefined;
  readonly mediaPoll?: { readonly ready: boolean; readonly checkInSeconds?: number | undefined } | undefined;
}

export interface DispatchFacts {
  readonly retryAfterMaxSeconds: number;
  readonly unverifiedHorizonDays: number;
  readonly readBackMode: string;
  readonly attemptCount: number;
  readonly latenessLeftSeconds: number;
  /** The operation's kind; a publish when absent. */
  readonly kind?: string | undefined;
  /** The remote id an edit or delete acts on. */
  readonly targetExternalId?: string | undefined;
}

const BACKOFF_SECONDS = [60, 300, 900, 3_600, 21_600] as const;

export const backoffSeconds = (step: number): number =>
  BACKOFF_SECONDS[Math.min(Math.max(step, 1), BACKOFF_SECONDS.length) - 1] as number;

export type ResultMove =
  | {
      row: 17;
      to: "published";
      evidence: {
        kind: "accepted";
        level: "receipt";
        outcome_kind: "post";
        refs: { source: "adapter"; external_id: string; permalink?: string };
      };
    }
  | {
      row: 17;
      to: "published";
      evidence: {
        kind: "edit_applied" | "removed";
        level: "receipt";
        outcome_kind: null;
        refs: { source: "adapter"; external_id: string };
      };
    }
  | { row: 22; to: "unknown_external_state"; checkInSeconds: number; horizonDays: number }
  | { row: 19; to: "retry_wait"; waitSeconds: number }
  | { row: 20; to: "failed" }
  | { row: 21; to: "paused"; reasonCode: "provider_cooldown"; waitSeconds: number };

function receipt(result: CallResult & { externalId: string }): ResultMove {
  return {
    row: 17,
    to: "published",
    evidence: {
      kind: "accepted",
      level: "receipt",
      outcome_kind: "post",
      refs: {
        source: "adapter",
        external_id: result.externalId,
        ...(result.permalink === undefined ? {} : { permalink: result.permalink }),
      },
    },
  };
}

function rateLimited(result: CallResult, facts: DispatchFacts): ResultMove {
  const move = denialMove({
    retryAfterSeconds:
      result.retryAfterMs === undefined
        ? backoffSeconds(facts.attemptCount)
        : Math.ceil(result.retryAfterMs / 1000),
    retryAfterMaxSeconds: facts.retryAfterMaxSeconds,
    latenessLeftSeconds: facts.latenessLeftSeconds,
  });
  return move.to === "paused"
    ? { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: move.waitSeconds ?? 1 }
    : { row: 19, to: "retry_wait", waitSeconds: move.to === "retry_wait" ? move.waitSeconds : 1 };
}

// A success with no id, or any failure that may have sent the call, is an unknown outcome: success is never simulated
// and a receipt needs an id.
export function resultMove(result: CallResult, facts: DispatchFacts): ResultMove {
  // An edit or a delete answers with no new id: its success is the call's own, and the id it acted on is the one held.
  const acted = facts.kind === "edit" ? "edit_applied" : facts.kind === "delete" ? "removed" : undefined;
  if (result.ok && acted !== undefined && facts.targetExternalId !== undefined)
    return {
      row: 17,
      to: "published",
      evidence: {
        kind: acted,
        level: "receipt",
        outcome_kind: null,
        refs: { source: "adapter", external_id: facts.targetExternalId },
      },
    };
  if (result.ok && result.externalId !== undefined)
    return receipt({ ...result, externalId: result.externalId });
  if (result.ok || result.effect === "possible")
    return {
      row: 22,
      to: "unknown_external_state",
      checkInSeconds: facts.readBackMode === "E" ? 0 : backoffSeconds(1),
      horizonDays: facts.unverifiedHorizonDays,
    };
  if (result.errorClass === "permanent") return { row: 20, to: "failed" };
  if (result.errorClass === "rate_limited") return rateLimited(result, facts);
  return { row: 19, to: "retry_wait", waitSeconds: backoffSeconds(facts.attemptCount) };
}

export interface PollFacts {
  readonly gapSeconds: number;
  readonly retryAfterMaxSeconds: number;
}

// Row 14 when every medium is ready, row 16 when the provider rejects one, row 13 when the grant is refused (the caller
// confirms the revocation first), otherwise the row keeps waiting until its deadline. A 404 never rejects: an attached medium answers 404, so it says nothing of readiness. Whatever a poll
// answers, it has no effect.
export type PollMove = { row: 13 } | { row: 14 } | { row: 16 } | { row: "wait"; checkInSeconds: number };

export function pollMove(result: CallResult, facts: PollFacts): PollMove {
  if (result.ok)
    return result.mediaPoll?.ready === true
      ? { row: 14 }
      : { row: "wait", checkInSeconds: result.mediaPoll?.checkInSeconds ?? facts.gapSeconds };
  if (result.errorClass === "auth_revoked") return { row: 13 };
  if (result.errorClass === "permanent" && result.httpStatus !== 404) return { row: 16 };
  const hinted = result.retryAfterMs === undefined ? undefined : Math.ceil(result.retryAfterMs / 1000);
  return {
    row: "wait",
    checkInSeconds: Math.min(Math.max(hinted ?? facts.gapSeconds, 1), facts.retryAfterMaxSeconds),
  };
}
