import { type ErrorCode, errorCodeSchema } from "@shoutory/core/errors";
import { type ZodType, z } from "zod";

/** What the screen shows for a failed call: each state has its own page or message (X-07). */
export type FailureState = "session_expired" | "maintenance" | "forbidden" | "not_found" | "error";

/** A call that failed: a coded refusal of the server, a network failure, or an answer that is not the contract. */
export class ApiError extends Error {
  readonly state: FailureState;
  readonly code: ErrorCode | "network" | "invalid_response";
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(code: ApiError["code"], status: number, requestId?: string, options?: { cause?: unknown }) {
    super(`api call failed: ${code}`, options);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.state = stateOf(code, status);
  }
}

function stateOf(code: ApiError["code"], status: number): FailureState {
  if (code === "unauthenticated" || status === 401) return "session_expired";
  if (code === "service_unavailable" || code === "network" || status === 503) return "maintenance";
  if (code === "forbidden") return "forbidden";
  if (code === "not_found") return "not_found";
  return "error";
}

// The envelope of an error answer (`apps/api` errors/refusal.ts); an unknown code is not trusted.
const errorEnvelope = z.object({
  error: z.object({ code: errorCodeSchema, requestId: z.string().optional() }),
});

const TIMEOUT_MS = 15_000;

export interface RequestInit {
  method?: string;
  body?: unknown;
}

// A refused connection, a dropped stream and a timeout are the only failures a caller can act on (maintenance);
// anything else is a bug and is not hidden.
// (A body that cannot be read is a TypeError in browsers and Node; happy-dom reports it as an EncodingError.)
const UNREACHABLE = new Set(["TimeoutError", "AbortError", "EncodingError"]);
const isNetworkFailure = (error: unknown) =>
  error instanceof TypeError || (error instanceof DOMException && UNREACHABLE.has(error.name));

async function send(path: string, init: RequestInit): Promise<Response> {
  const hasBody = init.body !== undefined;
  return await fetch(path, {
    method: init.method ?? "GET",
    // The server refuses an unsafe call without this header (CSRF); it is sent on every call.
    headers: { "X-Shoutory-Client": "web", ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    body: hasBody ? JSON.stringify(init.body) : null,
    // The same signal also ends a stalled body read, so the limit covers the whole call.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** One call: the answer's `data` parsed with `schema`, or an `ApiError`. */
export async function request<T>(schema: ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  let body: unknown;
  try {
    response = await send(path, init);
    body = await bodyOf(response);
  } catch (error) {
    if (isNetworkFailure(error)) throw new ApiError("network", 0, undefined, { cause: error });
    throw error;
  }
  if (!response.ok) {
    const failure = errorEnvelope.safeParse(body);
    if (failure.success) {
      throw new ApiError(failure.data.error.code, response.status, failure.data.error.requestId);
    }
    throw new ApiError("invalid_response", response.status);
  }
  const parsed = z.object({ data: schema }).safeParse(body);
  if (!parsed.success) throw new ApiError("invalid_response", response.status);
  return parsed.data.data;
}
