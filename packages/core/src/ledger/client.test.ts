import { describe, expect, it } from "vitest";
import { bucketKey, callTimeoutMs, denialMove, rereadOutcome, sweepArguments } from "./client.js";

describe("callTimeoutMs", () => {
  // [the call's own timeout ms, ms until the lease end the heartbeat last renewed, the timeout or null for no call]
  const ROWS: [number, number, number | null][] = [
    [30_000, 120_000, 30_000],
    [300_000, 120_000, 300_000],
    [300_000, 15_000, 300_000],
    [30_000, 10_001, 30_000],
    [30_000, 10_000, null],
    [30_000, -1_000, null],
  ];
  it.each(ROWS)(
    "a %i ms call timeout with %i ms to the renewed lease end gives %s (no call once under 10 s; the timeout itself otherwise)",
    (timeout, left, expected) => {
      expect(callTimeoutMs({ callTimeoutMs: timeout, leaseEndMs: 1_000_000 + left, nowMs: 1_000_000 })).toBe(
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
