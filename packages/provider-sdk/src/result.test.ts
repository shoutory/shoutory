import { describe, expect, it } from "vitest";
import { type Effect, errorResult, type ProviderErrorClass } from "./result.js";

const CLASSES: ProviderErrorClass[] = [
  "retryable_before_send",
  "retryable_after_send",
  "rate_limited",
  "auth_revoked",
  "permanent",
  "unknown",
];

// Each row: the effect and the classes an error may be reported with under it.
const VALID: [Effect, ProviderErrorClass[]][] = [
  ["none", CLASSES],
  ["possible", ["unknown", "retryable_after_send"]],
];
const INVALID: [Effect, ProviderErrorClass[]][] = [
  ["possible", ["retryable_before_send", "rate_limited", "auth_revoked", "permanent"]],
  ["confirmed", CLASSES],
];
const pairs = (rows: [Effect, ProviderErrorClass[]][]) =>
  rows.flatMap(([effect, classes]) =>
    classes.map((errorClass): [Effect, ProviderErrorClass] => [effect, errorClass]),
  );

describe("errorResult", () => {
  it.each(pairs(VALID))("keeps the class the adapter set under effect %s: %s", (effect, errorClass) => {
    expect(errorResult({ effect, errorClass })).toEqual({ ok: false, effect, errorClass });
  });

  it.each(pairs(INVALID))("refuses effect %s with class %s", (effect, errorClass) => {
    expect(() => errorResult({ effect, errorClass })).toThrow(/effect/);
  });

  it.each([
    [0, 0],
    [86_400_000, 86_400_000],
    [86_400_001, 86_400_000],
    [864_000_000, 86_400_000],
    [-1, undefined],
    [1.5, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
  ])("reports the retry delay %s as %s: a whole number, a day at most", (retryAfterMs, kept) => {
    const result = errorResult({ effect: "none", errorClass: "rate_limited", retryAfterMs });
    expect(result.retryAfterMs).toBe(kept);
  });

  it.each([
    ["invalid_grant", "invalid_grant"],
    ["not a code", undefined],
    ["x".repeat(65), undefined],
  ])("keeps provider code %j only in the shape of a code", (providerCode, kept) => {
    const result = errorResult({ effect: "none", errorClass: "permanent", providerCode });
    expect(result.providerCode).toBe(kept);
  });
});
