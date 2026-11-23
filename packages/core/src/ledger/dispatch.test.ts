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
  // The reconcile back-off of the operation ledger (V-69): 1 min, 5 min, 15 min, 1 h, then every 6 h.
  it.each([
    [1, 60],
    [2, 300],
    [3, 900],
    [4, 3_600],
    [5, 21_600],
    [40, 21_600],
  ])("step %i waits %i seconds", (step, seconds) => {
    // fails first because: the steps are off by one, or the last step does not repeat
    expect(backoffSeconds(step)).toBe(seconds);
  });
});

// [what the adapter answered, the facts that differ from FACTS, the move]
const MOVES: [string, CallResult, Partial<DispatchFacts>, object][] = [
  [
    "an answer with an id is published on a receipt (row 17)",
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
    "a success with no id is an unknown outcome, never a receipt (row 22)",
    { ok: true, effect: "confirmed" },
    {},
    { row: 22, to: "unknown_external_state", checkInSeconds: 60, horizonDays: 30 },
  ],
  [
    "an error that may have sent is unknown (row 22)",
    sent({ effect: "possible", errorClass: "unknown" }),
    {},
    { row: 22, to: "unknown_external_state", checkInSeconds: 60, horizonDays: 30 },
  ],
  [
    "an unknown on a provider that cannot read back is due at once (row 22)",
    sent({ effect: "possible", errorClass: "unknown" }),
    { readBackMode: "E" },
    { row: 22, to: "unknown_external_state", checkInSeconds: 0, horizonDays: 30 },
  ],
  [
    "a failure before the send retries on the back-off of its attempt (row 19)",
    sent({ errorClass: "retryable_before_send" }),
    { attemptCount: 3 },
    { row: 19, to: "retry_wait", waitSeconds: 900 },
  ],
  [
    "a revoked grant retries on the back-off, and the pre-flight of the next claim parks it if the revocation is confirmed (row 19, then row 13)",
    sent({ errorClass: "auth_revoked" }),
    {},
    { row: 19, to: "retry_wait", waitSeconds: 60 },
  ],
  [
    "a permanent failure ends the operation (row 20)",
    sent({ errorClass: "permanent" }),
    {},
    { row: 20, to: "failed" },
  ],
  [
    "a rate limit that fits the maximum waits for the retry (row 19)",
    sent({ errorClass: "rate_limited", retryAfterMs: 30_000 }),
    {},
    { row: 19, to: "retry_wait", waitSeconds: 30 },
  ],
  [
    "a rate limit beyond the maximum pauses with a cooldown (row 21)",
    sent({ errorClass: "rate_limited", retryAfterMs: 2_000_000 }),
    {},
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 2_000 },
  ],
  [
    "a rate limit beyond what is left of the window pauses (row 21)",
    sent({ errorClass: "rate_limited", retryAfterMs: 60_000 }),
    { latenessLeftSeconds: 10 },
    { row: 21, to: "paused", reasonCode: "provider_cooldown", waitSeconds: 60 },
  ],
  [
    "a rate limit with no delay still waits a second (row 19)",
    sent({ errorClass: "rate_limited" }),
    {},
    { row: 19, to: "retry_wait", waitSeconds: 1 },
  ],
];

describe("resultMove", () => {
  it.each(MOVES)("%s", (_name, result, facts, move) => {
    // fails first because: there is no table from an adapter's result to a ledger move
    expect(resultMove(result, { ...FACTS, ...facts })).toEqual(move);
  });
});
