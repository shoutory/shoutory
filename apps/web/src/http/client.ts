import { type ErrorCode, errorCodeSchema } from "@shoutory/core/errors";
import { type ZodType, z } from "zod";

export type FailureState = "session_expired" | "maintenance" | "forbidden" | "not_found" | "error";

export class ApiError extends Error {
  readonly state: FailureState;
  readonly code: ErrorCode | "network" | "invalid_response";
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ApiError["code"],
    status: number,
    requestId?: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, string>> },
  ) {
    super(`api call failed: ${code}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = options?.details;
    this.state = stateOf(code, status);
  }
}

// A 401 carrying another code of ours (wrong credentials, a wrong code) belongs to its own form, never an ended session.
function stateOf(code: ApiError["code"], status: number): FailureState {
  if (code === "unauthenticated" || (status === 401 && code === "invalid_response")) return "session_expired";
  if (code === "service_unavailable" || code === "network" || status === 503) return "maintenance";
  if (code === "forbidden") return "forbidden";
  if (code === "not_found") return "not_found";
  return "error";
}

const errorEnvelope = z.object({
  error: z.object({
    code: errorCodeSchema,
    requestId: z.string().optional(),
    // Anything but a map of text is no details: the refusal itself still counts.
    details: z.record(z.string(), z.string()).optional().catch(undefined),
  }),
});

const TIMEOUT_MS = 15_000;

export interface RequestInit {
  method?: string;
  body?: unknown;
  /** `false`: the answer has no `{data}` envelope (a library-forwarded one). */
  envelope?: boolean;
}

// Only these failures are treated as maintenance; anything else is a bug and is not hidden.
// happy-dom reports an unreadable body as an EncodingError.
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
      const { code, requestId, details } = failure.data.error;
      throw new ApiError(code, response.status, requestId, details ? { details } : {});
    }
    throw new ApiError("invalid_response", response.status);
  }
  const bare = init.envelope === false;
  const answer = bare ? schema : z.object({ data: schema }).transform((envelope) => envelope.data);
  const parsed = answer.safeParse(body);
  if (!parsed.success) throw new ApiError("invalid_response", response.status);
  return parsed.data;
}
