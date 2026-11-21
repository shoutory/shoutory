import { APIError } from "better-auth";
import { isUnavailable, Refusal, toRefusal } from "../errors/refusal.js";

// A wrong password or a wrong second-factor code. The challenge cookie's own error is not here: it stays
// `unauthenticated`, and the screen reads it as "sign-in expired, start again".
const WRONG_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_CODE",
  "INVALID_BACKUP_CODE",
]);

// The library's answers for a mailed link it rejects: unknown, used or expired.
const BAD_LINK_CODES: ReadonlySet<string> = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND"]);

function refusalFromBadRequest(code: string | undefined, message: string): Refusal {
  if (code !== undefined && BAD_LINK_CODES.has(code)) return new Refusal("link_unusable", message);
  // A password that is not the stored one (change-password's current password among them): the reason lets a screen
  // tell it from a new password the policy refuses, which has none.
  if (code === "INVALID_PASSWORD") {
    return new Refusal("validation_failed", message, { details: { reason: "current_password_wrong" } });
  }
  return new Refusal("validation_failed", message);
}

/** The one table that turns a library answer (status and error code) into our envelope's code. */
export function refusalFromAnswer(status: number, code: string | undefined): Refusal {
  const message = `auth answered ${status}${code ? ` ${code}` : ""}`;
  if (status === 400) return refusalFromBadRequest(code, message);
  if (status === 422) return new Refusal("validation_failed", message);
  if (status === 401) {
    const wrong = code !== undefined && WRONG_CREDENTIAL_CODES.has(code);
    return new Refusal(wrong ? "invalid_credentials" : "unauthenticated", message);
  }
  if (status === 403) {
    return new Refusal(code === "EMAIL_NOT_VERIFIED" ? "email_not_verified" : "forbidden", message);
  }
  if (status === 404) return new Refusal("not_found", message);
  if (status === 429) return new Refusal("too_many_requests", message);
  return new Refusal("internal_error", message);
}

/** A thrown library error: an outage under it is a 503, any other API error goes through the answer table. */
export function refusalFromThrown(error: unknown): Refusal {
  if (error instanceof APIError && !isUnavailable(error)) {
    const code = (error.body as { code?: unknown } | undefined)?.code;
    return refusalFromAnswer(error.statusCode, typeof code === "string" ? code : undefined);
  }
  return toRefusal(error);
}

/** A mailed link the library rejects is `link_unusable` (400), not a missing login (401) and not a refused input. */
export function refusalFromLinkError(error: unknown): Refusal {
  const code = error instanceof APIError ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (typeof code === "string" && BAD_LINK_CODES.has(code)) {
    return new Refusal("link_unusable", `the link was rejected: ${code}`);
  }
  return refusalFromThrown(error);
}

/** The error code of a failed library answer, or nothing when the body is not JSON (a plain 404 or 500). */
export async function answerCode(answer: Response): Promise<string | undefined> {
  const text = await answer.text();
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
