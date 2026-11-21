import { describe, expect, it } from "vitest";
import { healthOf } from "./health.js";

// R542 (3): a read that cannot be confirmed is not evidence of failure. Only a refusal the provider confirmed
// (`auth_revoked`, `permanent`) is `failing`; a limit, a cut-off or unknown answer is `degraded`; and no result here ever
// names a connection state, since only the refresh service's confirmed revocation moves one.
describe("healthOf", () => {
  it.each([
    ["a success with no health", { ok: true }, "ok"],
    ["a success the adapter calls ok", { ok: true, health: "ok" as const }, "ok"],
    ["a success the adapter calls degraded", { ok: true, health: "degraded" as const }, "degraded"],
    ["a rate limit", { ok: false, errorClass: "rate_limited" }, "degraded"],
    ["a failure before the request was sent", { ok: false, errorClass: "retryable_before_send" }, "degraded"],
    ["a failure after the request was sent", { ok: false, errorClass: "retryable_after_send" }, "degraded"],
    ["an unknown outcome", { ok: false, errorClass: "unknown" }, "degraded"],
    ["a confirmed revocation", { ok: false, errorClass: "auth_revoked" }, "failing"],
    ["a permanent refusal", { ok: false, errorClass: "permanent" }, "failing"],
  ])("%s is %s", (_name, result, expected) => {
    expect(healthOf(result)).toBe(expected);
  });
});
