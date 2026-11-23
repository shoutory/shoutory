import type { EgressRequest, EgressResponse } from "./client.js";
import { EgressError } from "./errors.js";

// A Response may not carry a body for these statuses.
const NO_BODY = new Set([101, 204, 205, 304]);

/** What an egress failure is to an adapter: the error codes it already classifies, and nothing of the original. */
function adapterError(error: unknown): unknown {
  if (!(error instanceof EgressError)) return error;
  if (error.effect === "none") return new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  if (error.class === "timeout") return new DOMException("the call timed out", "TimeoutError");
  return new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
}

const headersOf = (reply: EgressResponse): Headers =>
  new Headers(
    Object.entries(reply.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, [value].flat().join(", ")]],
    ),
  );

/**
 * The `fetch` of an adapter's context, made from a bound egress call (the one network path of the core, AGENTS 4.5): the
 * answer is a `Response` of its status, headers and body, and an egress failure is rethrown as the network error an adapter
 * knows how to classify (before the request was sent, a timeout, a cut connection).
 */
export function fetchOf(egress: (request: EgressRequest) => Promise<EgressResponse>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      const reply = await egress({
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      return new Response(NO_BODY.has(reply.status) ? null : reply.body, {
        status: reply.status,
        headers: headersOf(reply),
      });
    } catch (error) {
      throw adapterError(error);
    }
  };
}
