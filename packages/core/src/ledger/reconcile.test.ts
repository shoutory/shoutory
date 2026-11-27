import { describe, expect, it } from "vitest";
import type { CallResult } from "./dispatch.js";
import { actionReadOutcome, planReconcile, type ReconcileFacts, readBackOutcome } from "./reconcile.js";

const A: ReconcileFacts = {
  readBackMode: "A",
  resendAfterUnknown: "same_key_in_window",
  keyWindowSeconds: 3_600,
  maxInFlightSeconds: 60,
  readBackGapSeconds: 30,
  absentAnswers: [{ status: 404 }],
};
const without = (over: Partial<ReconcileFacts>): ReconcileFacts => ({ ...A, ...over });

describe("planReconcile", () => {
  // [facts, what the row holds, the plan]: the first committing attempt's age is that of the key's first use
  const ROWS: [
    string,
    ReconcileFacts,
    { externalId?: string; firstEffectAgoSeconds: number; reads?: number },
    object,
  ][] = [
    [
      "an id we hold is read back, never resent",
      A,
      { externalId: "p-1", firstEffectAgoSeconds: 10 },
      { kind: "read_back", externalId: "p-1" },
    ],
    [
      "read-back mode A inside the key window resends with the same key",
      A,
      { firstEffectAgoSeconds: 3_600 },
      { kind: "resend" },
    ],
    // A read-back by id needs an id: an unknown outcome that holds none can never be read back, so it goes to a person at
    // once instead of waiting for a horizon that nothing will change.
    [
      "read-back mode A with the key window passed and no id goes to a person: it cannot be read back",
      A,
      { firstEffectAgoSeconds: 3_601, reads: 1 },
      { kind: "needs_human", reason: "no_remote_id" },
    ],
    [
      "a provider that reads back only never resends; with no id it goes to a person",
      without({ resendAfterUnknown: "read_back_only" }),
      { firstEffectAgoSeconds: 10 },
      { kind: "needs_human", reason: "no_remote_id" },
    ],
    [
      "read-back mode B never resends after an unknown",
      without({ readBackMode: "B" }),
      { firstEffectAgoSeconds: 10 },
      { kind: "wait", checkInSeconds: 60 },
    ],
    [
      "a provider with no read-back is never resent and goes to a person",
      without({ readBackMode: "E", resendAfterUnknown: "read_back_only" }),
      { firstEffectAgoSeconds: 10 },
      { kind: "needs_human" },
    ],
  ];
  it.each(ROWS)("%s", (_name, facts, state, plan) => {
    expect(planReconcile(facts, state)).toEqual(plan);
  });
});

describe("readBackOutcome", () => {
  const found: CallResult = { ok: true, effect: "confirmed", externalId: "p-1" };
  const gone: CallResult = { ok: false, effect: "none", errorClass: "permanent", httpStatus: 404 };
  const refused: CallResult = { ok: false, effect: "none", errorClass: "permanent", httpStatus: 403 };
  // [what the read answered, how long since the effect started, absence reads so far, seconds since the last one, the outcome]
  const ROWS: [string, CallResult, number, number, number, string][] = [
    ["a post that is found is published on the read-back", found, 10, 0, 0, "published"],
    ["a refusal is not an absence", refused, 600, 2, 600, "inconclusive"],
    ["an absent answer before the call could still land is not an absence", gone, 30, 0, 0, "inconclusive"],
    ["the first absent answer after that waits for a second read", gone, 120, 0, 0, "absent_once"],
    ["a second absent answer inside the gap is not a second read", gone, 120, 1, 10, "absent_once"],
    ["a second absent answer after the gap proves the absence", gone, 120, 1, 30, "absent_proven"],
    [
      "an answer that says absent itself counts the same",
      { ok: false, effect: "none", absent: true },
      120,
      1,
      31,
      "absent_proven",
    ],
  ];
  it.each(ROWS)("%s", (_name, result, ago, reads, since, kind) => {
    expect(
      readBackOutcome(result, A, {
        lastEffectAgoSeconds: ago,
        absentReads: reads,
        secondsSinceAbsentRead: since,
      }).kind,
    ).toBe(kind);
  });

  it("a proven absence on a provider that never resends goes to a person, not back to retry", () => {
    const never = without({ resendAfterUnknown: "read_back_only" });
    expect(
      readBackOutcome(gone, never, { lastEffectAgoSeconds: 120, absentReads: 1, secondsSinceAbsentRead: 31 })
        .kind,
    ).toBe("needs_human");
  });

  it("a found post carries read-back evidence with its id", () => {
    expect(
      readBackOutcome(found, A, { lastEffectAgoSeconds: 10, absentReads: 0, secondsSinceAbsentRead: 0 }),
    ).toEqual({
      kind: "published",
      evidence: {
        kind: "verified",
        level: "read_back",
        outcome_kind: "post",
        refs: { source: "adapter", external_id: "p-1" },
      },
    });
  });
});

const DONE = (kind: string) => ({
  kind: "done",
  evidence: {
    kind,
    level: "read_back",
    outcome_kind: null,
    refs: { source: "adapter", external_id: "p-1" },
  },
});
const gone: CallResult = { ok: false, effect: "none", httpStatus: 404 };
const here: CallResult = { ok: true, effect: "none", externalId: "p-1" };
const holding = (text: string, settings: Record<string, string | number | boolean> = {}): CallResult => ({
  ...here,
  content: { text, settings },
});
const WANT = { text: "new", settings: { note: "", kept: true } };
// [case, the read, what the edit says, the outcome]
const ACTION_READS: [string, "edit" | "delete", CallResult, object][] = [
  ["a delete whose id answers 404 is removed", "delete", gone, DONE("removed")],
  ["a delete whose id is still there goes to a person", "delete", here, { kind: "needs_human" }],
  [
    "a delete read that fails is inconclusive",
    "delete",
    { ok: false, effect: "none", httpStatus: 503 },
    { kind: "inconclusive" },
  ],
  [
    "an edit whose text and returned settings match is applied, a setting it did not return left alone",
    "edit",
    holding("new", { note: "" }),
    DONE("edit_applied"),
  ],
  ["an edit whose text differs goes to a person", "edit", holding("old"), { kind: "needs_human" }],
  [
    "an edit whose returned setting differs goes to a person",
    "edit",
    holding("new", { note: "other" }),
    { kind: "needs_human" },
  ],
  [
    "an edit whose returned setting the frozen edit does not hold goes to a person",
    "edit",
    holding("new", { unknown: "x" }),
    { kind: "needs_human" },
  ],
  ["an edit read with no content goes to a person", "edit", here, { kind: "needs_human" }],
  ["an edit whose status is gone goes to a person", "edit", gone, { kind: "needs_human" }],
  [
    "an edit read that fails is inconclusive",
    "edit",
    { ok: false, effect: "none", httpStatus: 503 },
    { kind: "inconclusive" },
  ],
];
describe("actionReadOutcome", () => {
  it.each(ACTION_READS)("%s", (_name, kind, result, outcome) => {
    expect(
      actionReadOutcome({ kind, result, absentAnswers: A.absentAnswers, externalId: "p-1", expected: WANT }),
    ).toEqual(outcome);
  });
});

describe("read-back evidence", () => {
  it("read-back evidence carries the permalink when the answer has one", () => {
    const linked: CallResult = {
      ok: true,
      effect: "confirmed",
      externalId: "p-1",
      permalink: "https://example.test/p-1",
    };
    expect(
      readBackOutcome(linked, A, { lastEffectAgoSeconds: 10, absentReads: 0, secondsSinceAbsentRead: 0 }),
    ).toMatchObject({
      kind: "published",
      evidence: { refs: { source: "adapter", external_id: "p-1", permalink: "https://example.test/p-1" } },
    });
  });
});
