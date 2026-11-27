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

export type ActionReadOutcome =
  | {
      kind: "done";
      evidence: {
        kind: "edit_applied" | "removed";
        level: "read_back";
        outcome_kind: null;
        refs: { source: "adapter"; external_id: string };
      };
    }
  | { kind: "needs_human" | "inconclusive" };

const sameLines = (text: string): string => text.replaceAll("\r\n", "\n");

// What a read of the acted-on post says of an unknown edit or delete. A delete is done when the post is gone: one answer
// of absence is enough, since removal is what was asked. An edit is done only when the post holds the frozen text and
// settings the adapter could read back; a post that differs, has no readable content or is gone is a person's to decide.
export function actionReadOutcome(input: {
  kind: "edit" | "delete";
  result: CallResult;
  absentAnswers: readonly { readonly status?: number }[];
  externalId: string;
  expected?: { text: string; settings: Readonly<Record<string, string | number | boolean>> };
}): ActionReadOutcome {
  const { kind, result, expected } = input;
  const absent =
    result.absent === true ||
    (result.httpStatus !== undefined &&
      input.absentAnswers.some((answer) => answer.status === result.httpStatus));
  const done = (evidenceKind: "edit_applied" | "removed"): ActionReadOutcome => ({
    kind: "done",
    evidence: {
      kind: evidenceKind,
      level: "read_back",
      outcome_kind: null,
      refs: { source: "adapter", external_id: input.externalId },
    },
  });
  if (kind === "delete") {
    if (absent) return done("removed");
    return { kind: result.ok ? "needs_human" : "inconclusive" };
  }
  if (absent) return { kind: "needs_human" };
  if (!result.ok) return { kind: "inconclusive" };
  const held = result.content;
  const matches =
    held !== undefined &&
    expected !== undefined &&
    sameLines(held.text) === sameLines(expected.text) &&
    Object.entries(held.settings).every(([key, value]) => expected.settings[key] === value);
  return matches ? done("edit_applied") : { kind: "needs_human" };
}
