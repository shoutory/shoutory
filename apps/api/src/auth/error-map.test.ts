import { APIError } from "better-auth";
import { describe, expect, it } from "vitest";
import { refusalFromAnswer, refusalFromLinkError } from "./error-map.js";

// A mailed link the library rejects (unknown, used or expired) is `link_unusable` on both paths: the answer
// of a forwarded reset (a status and a code) and the thrown error of the in-process verify. A refused input is not.
describe("the mailed-link answers", () => {
  it.each([
    ["an unknown or used token", "INVALID_TOKEN"],
    ["an expired token", "TOKEN_EXPIRED"],
    ["a token whose user is gone", "USER_NOT_FOUND"],
  ])("%s answers 400 as link_unusable on the forwarded path", (_name, code) => {
    expect(refusalFromAnswer(400, code).code).toBe("link_unusable");
  });

  it.each(["INVALID_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND"])(
    "%s thrown by the verify is link_unusable",
    (code) => {
      expect(refusalFromLinkError(new APIError("BAD_REQUEST", { message: code, code })).code).toBe(
        "link_unusable",
      );
    },
  );

  it("a refused password stays validation_failed", () => {
    expect(refusalFromAnswer(400, "PASSWORD_TOO_SHORT").code).toBe("validation_failed");
  });
});

// The one table from a library answer to our envelope's code. A wrong second-factor code is a wrong
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
