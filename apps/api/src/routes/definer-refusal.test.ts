import { describe, expect, it } from "vitest";
import { definerRefusal } from "./definer-refusal.js";

const raised = (code: string, message: string, detail?: string) =>
  Object.assign(new Error(message), { code, detail });
const DETAIL = "expires 2026-11-20 10:00:00.123456+00; invited by Someone Else";
const EXPIRES = "2026-11-20T10:00:00.000Z";
const ACCEPT = "invitation_accept";
const UNUSABLE = "invitation_unusable";

describe("definerRefusal", () => {
  // state, message, DETAIL, code, details
  it.each([
    ["SH403", `${ACCEPT}: email_mismatch`, undefined, "forbidden", { reason: "email_mismatch" }],
    ["SH403", "member_role_set: rank too low", undefined, "forbidden", undefined],
    ["SH409", "member_remove: last_owner", undefined, "conflict", { reason: "last_owner" }],
    ["42501", "invitation_revoke: refused", undefined, "not_found", undefined],
    ["SH410", `${ACCEPT}: used`, DETAIL, UNUSABLE, { reason: "used" }],
    // The expiry only, and never the inviter's name.
    ["SH410", `${ACCEPT}: expired`, DETAIL, UNUSABLE, { reason: "expired", expires_at: EXPIRES }],
    ["SH410", `${ACCEPT}: expired`, "expires soon", UNUSABLE, { reason: "expired" }],
  ])("%s %s maps to %s", (state, message, detail, code, details) => {
    const refusal = definerRefusal(raised(state, message, detail));
    expect([refusal?.code, refusal?.details]).toEqual([code, details]);
  });

  // R533 (A): the creation bucket's refusal is a 429 whose Retry-After is the seconds the definer put in DETAIL.
  it.each([
    ["workspace_create", "retry after 42 seconds", 42],
    ["organization_create", "retry after 3600 seconds", 3600],
  ])("SH429 from %s maps to too_many_requests with %s", (name, detail, seconds) => {
    const refusal = definerRefusal(raised("SH429", `${name}: rate_limited`, detail));
    expect([refusal?.code, refusal?.retryAfterSeconds]).toEqual(["too_many_requests", seconds]);
  });

  it.each([
    ["SH429", "member_remove: rate_limited", "retry after 5 seconds"],
    ["SH429", "workspace_create: rate_limited", "retry after soon"],
  ])("%s %s with DETAIL %j is not a refusal with a valid retry time", (state, message, detail) => {
    expect(definerRefusal(raised(state, message, detail))?.retryAfterSeconds).toBeUndefined();
  });

  it.each([
    ["SH403", "some_other_function: email_mismatch"],
    ["23505", "invitation_create: duplicate"],
    ["SH409", "my_workspaces: last_owner"],
  ])("%s %s is not a refusal", (state, message) => {
    expect(definerRefusal(raised(state, message))).toBeUndefined();
  });
});
