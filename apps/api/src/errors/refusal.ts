import type { ErrorCode } from "@shoutory/core/errors";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../routes/define-route.js";

/** What the client may be told per code. The author's message goes to the log only, so no input is ever echoed. */
const PUBLIC: Record<ErrorCode, { status: ContentfulStatusCode; message: string }> = {
  validation_failed: { status: 400, message: "The request did not match the expected shape." },
  payload_too_large: { status: 413, message: "The request body is too large." },
  unsupported_media_type: { status: 415, message: "The request body must be application/json." },
  not_found: { status: 404, message: "Not found." },
  csrf_rejected: { status: 403, message: "The request was refused." },
  unauthenticated: { status: 401, message: "Authentication is required." },
  invalid_credentials: { status: 401, message: "The email or password is not correct." },
  email_not_verified: { status: 403, message: "The email address is not verified." },
  forbidden: { status: 403, message: "The request is not allowed." },
  conflict: { status: 409, message: "The request conflicts with the current state." },
  limit_reached: { status: 409, message: "A limit has been reached." },
  step_up_required: { status: 403, message: "Confirm your identity again to continue." },
  password_reset_required: { status: 403, message: "Reset your password to continue." },
  too_many_requests: { status: 429, message: "Too many requests. Try again later." },
  service_unavailable: { status: 503, message: "The service is not available right now." },
  internal_error: { status: 500, message: "Something went wrong." },
};
const RETRY_AFTER_SECONDS = "5";

interface RefusalOptions extends ErrorOptions {
  /** Fixed, non-user values only: they are sent to the client. */
  readonly details?: Readonly<Record<string, string>>;
  /** Seconds the client waits before retrying; sent as `Retry-After` on a 429 (the bucket's answer). */
  readonly retryAfterSeconds?: number;
}

/** A typed refusal: the one way a handler or middleware answers with an error. */
export class Refusal extends Error {
  readonly details: Readonly<Record<string, string>> | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options: RefusalOptions = {},
  ) {
    super(message, options);
    this.name = "Refusal";
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
]);
const UNAVAILABLE_MESSAGES = [/timeout exceeded when trying to connect/i, /connection terminated/i];

// A query builder wraps the driver error (Drizzle keeps it in `cause`), so the chain is read, to a bound.
const MAX_CAUSE_DEPTH = 5;

/**
 * A database outage: a connection that is refused, reset or timed out, SQLSTATE class 08 and 57P01 to 57P03, found
 * on the error or on a cause up to five levels down.
 */
export function isUnavailable(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (UNAVAILABLE_CODES.has(code) || code.startsWith("08"))) return true;
  if (UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(error.message))) return true;
  if (depth >= MAX_CAUSE_DEPTH) return false;
  if (error instanceof AggregateError && error.errors.some((inner) => isUnavailable(inner, depth + 1))) {
    return true;
  }
  return isUnavailable(error.cause, depth + 1);
}

const FROM_HTTP_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: "validation_failed",
  404: "not_found",
  413: "payload_too_large",
  415: "unsupported_media_type",
};

/** Maps anything thrown on a request path to a refusal; an unknown error becomes a 500 with no detail. */
export function toRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof HTTPException) {
    const code = FROM_HTTP_STATUS[error.status] ?? "internal_error";
    return new Refusal(code, error.message, { cause: error });
  }
  if (isUnavailable(error))
    return new Refusal("service_unavailable", "database unavailable", { cause: error });
  return new Refusal("internal_error", "unhandled error", { cause: error });
}

/** The error envelope of the public API; every 503 carries `Retry-After` (NFR-REL-13). */
export function errorResponse(c: Context<AppEnv>, refusal: Refusal): Response {
  const { status, message } = PUBLIC[refusal.code];
  if (status === 503) c.header("Retry-After", RETRY_AFTER_SECONDS);
  if (status === 429) c.header("Retry-After", String(refusal.retryAfterSeconds ?? RETRY_AFTER_SECONDS));
  const requestId = c.get("requestId");
  return c.json({ error: { code: refusal.code, message, details: refusal.details, requestId } }, status);
}
