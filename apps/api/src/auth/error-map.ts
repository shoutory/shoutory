import { APIError } from "better-auth";
import { isUnavailable, Refusal, toRefusal } from "../errors/refusal.js";

/** The one table that turns a library answer (status and error code) into our envelope's code (R113). */
export function refusalFromAnswer(status: number, code: string | undefined): Refusal {
  const message = `auth answered ${status}${code ? ` ${code}` : ""}`;
  if (status === 400 || status === 422) return new Refusal("validation_failed", message);
  if (status === 401) {
    return new Refusal(
      code === "INVALID_EMAIL_OR_PASSWORD" ? "invalid_credentials" : "unauthenticated",
      message,
    );
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

const BAD_LINK_CODES: ReadonlySet<string> = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED", "USER_NOT_FOUND"]);

/** A mailed link the library rejects is a bad request of ours (400), not a missing login (401). */
export function refusalFromLinkError(error: unknown): Refusal {
  const code = error instanceof APIError ? (error.body as { code?: unknown } | undefined)?.code : undefined;
  if (typeof code === "string" && BAD_LINK_CODES.has(code)) {
    return new Refusal("validation_failed", `the link was rejected: ${code}`);
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
