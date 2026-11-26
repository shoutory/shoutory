import { backoffSeconds, type CallResult } from "./dispatch.js";

export interface ReconcileFacts {
  readonly readBackMode: string;
  readonly resendAfterUnknown: "same_key_in_window" | "read_back_only";
  readonly keyWindowSeconds: number;
  readonly maxInFlightSeconds: number;
  readonly readBackGapSeconds: number;
  readonly absentAnswers: readonly { readonly status?: number }[];
}

export type ReconcilePlan =
  | { kind: "read_back"; externalId: string }
  | { kind: "resend" }
  | { kind: "wait"; checkInSeconds: number }
  | { kind: "needs_human"; reason?: "no_remote_id" };

// An id we hold is read back, never resent. A provider that reads back only by id and cannot resend holds nothing to read
// when the answer was lost, so it goes to a person at once; the other classes keep waiting, as they may read back by
// other means.
export function planReconcile(
  facts: ReconcileFacts,
  state: { externalId?: string | undefined; firstEffectAgoSeconds: number; reads?: number | undefined },
): ReconcilePlan {
  if (state.externalId !== undefined) return { kind: "read_back", externalId: state.externalId };
  if (facts.readBackMode === "E") return { kind: "needs_human" };
  const mayResend =
    facts.readBackMode === "A" &&
    facts.resendAfterUnknown === "same_key_in_window" &&
    state.firstEffectAgoSeconds <= facts.keyWindowSeconds;
  if (mayResend) return { kind: "resend" };
  if (facts.readBackMode === "A") return { kind: "needs_human", reason: "no_remote_id" };
  return { kind: "wait", checkInSeconds: backoffSeconds((state.reads ?? 0) + 1) };
}

export type ReadBackOutcome =
  | {
      kind: "published";
      evidence: {
        kind: "verified";
        level: "read_back";
        outcome_kind: "post";
        refs: { source: "adapter"; external_id: string; permalink?: string };
      };
    }
  | { kind: "inconclusive" | "absent_once" | "absent_proven" | "needs_human" };

const isAbsent = (result: CallResult, facts: ReconcileFacts): boolean =>
  result.absent === true ||
  (result.httpStatus !== undefined &&
    facts.absentAnswers.some((answer) => answer.status === result.httpStatus));

// An absence is proven only by the provider's own absent answer (a refusal is not one), read after the latest send can no
// longer land, and read twice a gap apart. An absence read before a resend does not count.
export function readBackOutcome(
  result: CallResult,
  facts: ReconcileFacts,
  state: { lastEffectAgoSeconds: number; absentReads: number; secondsSinceAbsentRead: number },
): ReadBackOutcome {
  if (result.ok && result.externalId !== undefined)
    return {
      kind: "published",
      evidence: {
        kind: "verified",
        level: "read_back",
        outcome_kind: "post",
        refs: {
          source: "adapter",
          external_id: result.externalId,
          ...(result.permalink === undefined ? {} : { permalink: result.permalink }),
        },
      },
    };
  if (!isAbsent(result, facts) || state.lastEffectAgoSeconds < facts.maxInFlightSeconds)
    return { kind: "inconclusive" };
  const second = state.absentReads > 0 && state.secondsSinceAbsentRead >= facts.readBackGapSeconds;
  if (!second) return { kind: "absent_once" };
  // A proven absence goes back to retry only where the manifest allows a resend; otherwise a person decides.
  return { kind: facts.resendAfterUnknown === "same_key_in_window" ? "absent_proven" : "needs_human" };
}
