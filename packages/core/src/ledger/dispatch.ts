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
}

export interface DispatchFacts {
  readonly retryAfterMaxSeconds: number;
  readonly unverifiedHorizonDays: number;
  readonly readBackMode: string;
  readonly attemptCount: number;
  readonly latenessLeftSeconds: number;
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
    retryAfterSeconds: Math.ceil((result.retryAfterMs ?? 0) / 1000),
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
