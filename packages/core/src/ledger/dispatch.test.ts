import { describe, expect, it } from "vitest";
import { backoffSeconds, type CallResult, type DispatchFacts, resultMove } from "./dispatch.js";

const FACTS: DispatchFacts = {
  retryAfterMaxSeconds: 900,
  unverifiedHorizonDays: 30,
  readBackMode: "A",
  attemptCount: 1,
  latenessLeftSeconds: 7_200,
};
const sent = (over: Partial<CallResult>): CallResult => ({ ok: false, effect: "none", ...over });

describe("backoffSeconds", () => {
  it.each([
    [1, 60],
    [2, 300],
    [3, 900],
    [4, 3_600],
    [5, 21_600],
    [40, 21_600],
  ])("step %i waits %i seconds", (step, seconds) => {
    expect(backoffSeconds(step)).toBe(seconds);
  });
});

// [what the adapter answered, the facts that differ from FACTS, the move]
const MOVES: [string, CallResult, Partial<DispatchFacts>, object][] = [
  [
    "an answer with an id is published on a receipt",
    { ok: true, effect: "confirmed", externalId: "p-1", permalink: "https://x.test/p-1" },
    {},
    {
      row: 17,
      to: "published",
      evidence: {
        kind: "accepted",
        level: "receipt",
        outcome_kind: "post",
        refs: { source: "adapter", external_id: "p-1", permalink: "https://x.test/p-1" },
      },
    },
  ],
  [
    "a success with no id is an unknown outcome, never a receipt",
    { ok: true, effect: "confirmed" },
    {},
    { row: 22, to: "unknown_external_state", checkInSeconds: 60, horizonDays: 30 },
  ],
  [
    "an error that may have sent is unknown",
    sent({ effect: "possible", errorClass: "unknown" }),
    {},
    { row: 22, to: "unknown_external_state", checkInSeconds: 60, horizonDays: 30 },
  ],
  [
    "an unknown on a provider that cannot read back is due at once",
    sent({ effect: "possible", errorClass: "unknown" }),
    { readBackMode: "E" },
    { row: 22, to: "unknown_external_state", checkInSeconds: 0, horizonDays: 30 },
  ],
  [
    "a failure before the send retries on the back-off of its attempt",
    sent({ errorClass: "retryable_before_send" }),
    { attemptCount: 3 },
    { row: 19, to: "retry_wait", waitSeconds: 900 },
  ],
  [
    "a revoked grant retries on the back-off, and the pre-flight of the next claim parks it if the revocation is confirmed",
    sent({ errorClass: "auth_revoked" }),
    {},
    { row: 19, to: "retry_wait", waitSeconds: 60 },
  ],
  [
    "a revoked grant on a call that may have sent is unknown, never a retry",
    sent({ effect: "possible", errorClass: "auth_revoked" }),
    {},
    { row: 22, to: "unknown_external_state", checkInSeconds: 60, horizonDays: 30 },
  ],
  [
    "a permanent failure ends the operation",
    sent({ errorClass: "permanent" }),
    {},
    { row: 20, to: "failed" },
  ],
  [
    "a rate limit that fits the maximum waits for the retry",
    sent({ errorClass: "rate_limited", retryAfterMs: 30_000 }),
    {},
    { row: 19, to: "retry_wait", waitSeconds: 30 },
  ],
  [
    "a rate limit beyond the maximum pauses with a cooldown",
    sent({ errorClass: "rate_limited", retryAfterMs: 2_000_000 }),
    {},
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 2_000 },
  ],
  [
    "a rate limit beyond what is left of the window pauses",
    sent({ errorClass: "rate_limited", retryAfterMs: 60_000 }),
    { latenessLeftSeconds: 10 },
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 60 },
  ],
  [
    "a rate limit with no delay waits the back-off of its attempt, not a second",
    sent({ errorClass: "rate_limited" }),
    { attemptCount: 3 },
    { row: 19, to: "retry_wait", waitSeconds: 900 },
  ],
  [
    "a rate limit with no delay whose back-off is beyond the maximum pauses with a cooldown",
    sent({ errorClass: "rate_limited" }),
    { attemptCount: 5 },
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 21_600 },
  ],
  [
    "a rate limit of one day, the most an adapter reports, pauses with a cooldown",
    sent({ errorClass: "rate_limited", retryAfterMs: 86_400_000 }),
    {},
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 86_400 },
  ],
];

describe("resultMove", () => {
  it.each(MOVES)("%s", (_name, result, facts, move) => {
    expect(resultMove(result, { ...FACTS, ...facts })).toEqual(move);
  });
});
