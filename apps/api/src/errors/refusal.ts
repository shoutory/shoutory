import type { ErrorCode } from "@shoutory/core/errors";
import { StorageError, type StorageErrorKind } from "@shoutory/core/storage";
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
  precondition_failed: { status: 412, message: "The resource has changed since it was read." },
  precondition_required: { status: 428, message: "This request must say which version it is based on." },
  unprocessable_content: { status: 422, message: "The content could not be accepted." },
  limit_reached: { status: 409, message: "A limit has been reached." },
  invitation_unusable: { status: 410, message: "The invitation can no longer be used." },
  link_unusable: { status: 400, message: "The link can no longer be used." },
  step_up_required: { status: 403, message: "Confirm your identity again to continue." },
  password_reset_required: { status: 403, message: "Reset your password to continue." },
  too_many_requests: { status: 429, message: "Too many requests. Try again later." },
  service_unavailable: { status: 503, message: "The service is not available right now." },
  internal_error: { status: 500, message: "Something went wrong." },
};
const RETRY_AFTER_SECONDS = "5";

interface SettingIssue {
  readonly variant: number;
  readonly key: string;
  readonly reason: string;
}
// What the person may do about a refusal, in words the screens know, and the work that stands in the way.
interface Blocking {
  readonly kind: "operation";
  readonly id: string;
  readonly post_id: string;
  readonly channel_name: string;
  readonly state: string;
}
export type RefusalDetails = Readonly<
  Record<string, string | boolean | readonly SettingIssue[] | readonly string[] | readonly Blocking[]>
>;

interface RefusalOptions extends ErrorOptions {
  /** Fixed values and the caller's own setting names only: they are sent to the client. */
  readonly details?: RefusalDetails;
  readonly etag?: string;
  readonly retryAfterSeconds?: number;
}

export class Refusal extends Error {
  readonly details: RefusalDetails | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly etag: string | undefined;
  constructor(
    readonly code: ErrorCode,
    message: string,
    options: RefusalOptions = {},
  ) {
    super(message, options);
    this.name = "Refusal";
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.etag = options.etag;
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

// What a storage failure means to a client. A store that is down, refuses the keys or cannot hold originals is an
// outage the operator fixes (the kind is in the log through the cause); a key or a path outside the root is a code defect.
const STORAGE_REFUSALS: Readonly<Record<StorageErrorKind, ErrorCode>> = {
  failed: "service_unavailable",
  denied: "service_unavailable",
  unsupported: "service_unavailable",
  exists: "conflict",
  too_large: "conflict",
  invalid_key: "internal_error",
  outside_root: "internal_error",
};

export function toRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof StorageError)
    return new Refusal(STORAGE_REFUSALS[error.kind], "storage refused the operation", { cause: error });
  if (error instanceof HTTPException) {
    const code = FROM_HTTP_STATUS[error.status] ?? "internal_error";
    return new Refusal(code, error.message, { cause: error });
  }
  if (isUnavailable(error))
    return new Refusal("service_unavailable", "database unavailable", { cause: error });
  return new Refusal("internal_error", "unhandled error", { cause: error });
}

export function errorResponse(c: Context<AppEnv>, refusal: Refusal): Response {
  const { status, message } = PUBLIC[refusal.code];
  if (status === 503) c.header("Retry-After", RETRY_AFTER_SECONDS);
  if (status === 429) c.header("Retry-After", String(refusal.retryAfterSeconds ?? RETRY_AFTER_SECONDS));
  if (refusal.etag !== undefined) c.header("ETag", refusal.etag);
  const requestId = c.get("requestId");
  // The public probe names no cause: a caller must not learn which dependency is down (the log carries it).
  const details = c.req.path === "/readyz" ? undefined : refusal.details;
  return c.json({ error: { code: refusal.code, message, details, requestId } }, status);
}
