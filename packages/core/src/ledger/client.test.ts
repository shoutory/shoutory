import { describe, expect, it } from "vitest";
import { bucketKey, callTimeoutMs, denialMove, rereadOutcome, sweepArguments } from "./client.js";

describe("callTimeoutMs", () => {
  // [manifest timeout ms, lease seconds, ms since the claim started, the timeout or null for no call]
  const ROWS: [number, number, number, number | null][] = [
    [30_000, 120, 0, 30_000],
    [30_000, 120, 95_000, 15_000],
    [30_000, 60, 45_000, 5_000],
    [30_000, 60, 50_000, null],
    [30_000, 60, 61_000, null],
  ];
  it.each(ROWS)(
    "a %i ms call timeout with a %i s lease started %i ms ago gives %s (min of the timeout and what is left minus 10 s)",
    (timeout, lease, elapsed, expected) => {
      expect(callTimeoutMs({ manifestTimeoutMs: timeout, leaseSeconds: lease, elapsedMs: elapsed })).toBe(
        expected,
      );
    },
  );
});

describe("rereadOutcome", () => {
  // [channel state, whether the target is live, the move or null to go on]
  const ROWS: [string, boolean, object | null][] = [
    ["connected", true, null],
    ["connected", false, { to: "failed" }],
    ["disabled", true, { to: "paused", reasonCode: "channel_disabled" }],
    ["needs_reconnect", true, { to: "blocked_reconnect" }],
    ["disconnected", true, { to: "blocked_reconnect" }],
    ["revoked_by_provider", true, { to: "blocked_reconnect" }],
  ];
  it.each(ROWS)("a %s channel with a live target %s gives %j", (channelState, targetLive, expected) => {
    expect(rereadOutcome({ channelState, targetLive })).toEqual(expected);
  });
});

describe("sweepArguments", () => {
  it("lists every provider for the lease sweep and only the live ones for the due-move sweep", () => {
    const base = { readBackMode: "A", maxAttempts: 5, unverifiedHorizonDays: 30 };
    const { leases, due } = sweepArguments([
      { id: "live", live: true, ...base },
      { id: "retired", live: false, ...base },
    ]);
    expect([Object.keys(leases), Object.keys(due)]).toEqual([["live", "retired"], ["live"]]);
    expect(due.live).toEqual({ max_attempts: 5 });
  });
});

describe("denialMove", () => {
  // [retry after, manifest maximum, lateness left, the move]
  const ROWS: [number, number, number, object][] = [
    [40, 900, 7_200, { to: "retry_wait", waitSeconds: 40 }],
    [0, 900, 7_200, { to: "retry_wait", waitSeconds: 1 }],
    [40, 30, 7_200, { to: "paused", reasonCode: "provider_cooldown", waitSeconds: 40 }],
    [40, 900, 20, { to: "paused", reasonCode: "provider_cooldown", waitSeconds: 40 }],
  ];
  it.each(ROWS)(
    "a denial of %i s (maximum %i s, %i s of lateness left) moves %j",
    (after, max, left, move) => {
      expect(
        denialMove({ retryAfterSeconds: after, retryAfterMaxSeconds: max, latenessLeftSeconds: left }),
      ).toEqual(move);
    },
  );
});

describe("bucketKey", () => {
  const channel = { provider_id: "fixture", provider_account_id: "acct-1", instance_host: "social.example" };
  const key = (over: Record<string, unknown> = {}, ch: Record<string, string | null> = channel) =>
    bucketKey({ limitName: "posts", scope: "account", keyName: "account", channel: ch, ...over } as never);

  it("is a 64-hex digest, shared by one account and different for another account, instance, provider or limit name", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
    expect(key()).toBe(key());
    const other = [
      key({}, { ...channel, provider_account_id: "acct-2" }),
      key({ keyName: "instance" }),
      key({}, { ...channel, provider_id: "other" }),
      key({ limitName: "comments" }),
      key({ scope: "chat" }),
    ];
    expect(new Set([key(), ...other]).size).toBe(6);
  });

  it.each([
    ["an unmapped key name", { keyName: "region" }, channel],
    ["a null account column", {}, { ...channel, provider_account_id: null }],
    ["a null instance column", { keyName: "instance" }, { ...channel, instance_host: null }],
  ])("refuses %s", (_name, over, ch) => {
    expect(() => key(over, ch)).toThrow();
  });
});
