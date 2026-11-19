import { describe, expect, it } from "vitest";
import { refusalFromAnswer } from "./error-map.js";

// R113 and R404: the one table from a library answer to our envelope's code. A wrong second-factor code is a wrong
// credential (the screen says "that code is not right"); only the challenge cookie's own error reads as a login that
// has ended (the screen says "sign-in expired, start again").
describe("the auth answer table", () => {
  it.each([
    ["a wrong password", 401, "INVALID_EMAIL_OR_PASSWORD", "invalid_credentials"],
    ["a wrong TOTP code", 401, "INVALID_CODE", "invalid_credentials"],
    ["a wrong recovery code", 401, "INVALID_BACKUP_CODE", "invalid_credentials"],
    ["an expired or missing challenge cookie", 401, "INVALID_TWO_FACTOR_COOKIE", "unauthenticated"],
    ["a 401 with no code", 401, undefined, "unauthenticated"],
    ["an unverified email", 403, "EMAIL_NOT_VERIFIED", "email_not_verified"],
    ["a refused input", 400, "INVALID_CODE_FORMAT", "validation_failed"],
    ["a lock or a replay", 429, undefined, "too_many_requests"],
  ])("%s answers %s %s as %s", (_name, status, code, expected) => {
    expect(refusalFromAnswer(status, code).code).toBe(expected);
  });
});
