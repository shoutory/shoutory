import type { Effect } from "../result.js";

export type EgressErrorClass =
  | "invalid_url"
  | "blocked_url"
  | "blocked_address"
  | "host_not_allowed"
  | "too_many_redirects"
  | "redirect_refused"
  | "dns"
  | "connect_timeout"
  | "connect"
  | "timeout"
  | "size_exceeded"
  | "network";

/**
 * The only error the egress client throws (review M8). It carries the class, the host and a status, and never the
 * original error: undici errors can hold the full URL with query tokens and the request headers.
 */
export class EgressError extends Error {
  readonly class: EgressErrorClass;
  readonly host: string;
  readonly status: number | undefined;
  /** Whether the request may have taken effect: none before sending, possible after. */
  readonly effect: Effect;

  constructor(init: { class: EgressErrorClass; host: string; status?: number; effect?: Effect }) {
    super(`egress ${init.class} for ${init.host}`);
    this.name = "EgressError";
    this.class = init.class;
    this.host = init.host;
    this.status = init.status;
    this.effect = init.effect ?? "none";
  }
}

const BEFORE_SENDING: Readonly<Record<string, EgressErrorClass>> = {
  UND_ERR_CONNECT_TIMEOUT: "connect_timeout",
  ECONNREFUSED: "connect",
  EHOSTUNREACH: "connect",
  ENETUNREACH: "connect",
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
};
const AFTER_SENDING: Readonly<Record<string, EgressErrorClass>> = {
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  UND_ERR_RES_EXCEEDED_MAX_SIZE: "size_exceeded",
};

// The classes where the operator policy or the request's host binding refused the call before anything was sent.
const POLICY_REFUSALS: ReadonlySet<EgressErrorClass> = new Set([
  "invalid_url",
  "blocked_url",
  "blocked_address",
  "host_not_allowed",
  "too_many_redirects",
  "redirect_refused",
]);

/** Whether an error an adapter's `fetch` threw is the egress policy refusing the address (see `fetchOf`). */
export function isPolicyRefusal(error: unknown): boolean {
  const egress =
    error instanceof Error ? (error.cause as { egress?: EgressErrorClass } | undefined)?.egress : undefined;
  return egress !== undefined && POLICY_REFUSALS.has(egress);
}

/** The error code on an error or on its cause chain; the text of an error is never read. */
function codeOf(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

/** Turns any network failure into an `EgressError` that holds no part of the original. */
export function wrapNetworkError(error: unknown, host: string): EgressError {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current instanceof EgressError) return current;
    current = current.cause;
  }
  const code = codeOf(error);
  const before = code === undefined ? undefined : BEFORE_SENDING[code];
  if (before !== undefined) return new EgressError({ class: before, host, effect: "none" });
  const after = code === undefined ? undefined : AFTER_SENDING[code];
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  const cls = after ?? (timedOut ? "timeout" : "network");
  return new EgressError({ class: cls, host, effect: "possible" });
}
