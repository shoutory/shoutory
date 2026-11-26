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
  idempotencyKey?: string;
  /** For a call that sends a file: a large one needs longer than the default on a slow link. */
  timeoutMs?: number;
}

// Only these failures are treated as maintenance; anything else is a bug and is not hidden.
// happy-dom reports an unreadable body as an EncodingError.
const UNREACHABLE = new Set(["TimeoutError", "AbortError", "EncodingError"]);
const isNetworkFailure = (error: unknown) =>
  error instanceof TypeError || (error instanceof DOMException && UNREACHABLE.has(error.name));

async function send(path: string, init: RequestInit): Promise<Response> {
  const hasBody = init.body !== undefined;
  // A file goes as its own bytes; the browser states its length.
  const file = init.body instanceof Blob ? init.body : null;
  return await fetch(path, {
    method: init.method ?? "GET",
    // The server refuses an unsafe call without this header (CSRF); it is sent on every call.
    headers: {
      "X-Shoutory-Client": "web",
      ...(hasBody ? { "Content-Type": file ? "application/octet-stream" : "application/json" } : {}),
      ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: file ?? (hasBody ? JSON.stringify(init.body) : null),
    // The same signal also ends a stalled body read, so the limit covers the whole call.
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
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

// 50 pages of 100 is far past any list a person reads; a list that does not end there is shown as an error, never cut.
const MAX_PAGES = 50;

/** Reads every page of a cursor-paged list by following `next_cursor`. */
export async function requestPages<T>(schema: ZodType<T[]>, path: string): Promise<T[]> {
  const page = z.object({ data: schema, meta: z.object({ next_cursor: z.string().nullable() }) });
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let read = 0; read < MAX_PAGES; read++) {
    const at: string =
      cursor === null ? path : `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
    const answer = await request(page, at, { envelope: false });
    rows.push(...answer.data);
    cursor = answer.meta.next_cursor;
    if (cursor === null) return rows;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new ApiError("invalid_response", 200);
}

/** A UUIDv7 (RFC 9562 section 5.7): 48 bits of milliseconds, then random bits. */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, Math.floor(now / 2 ** 32));
  view.setUint32(2, now % 2 ** 32);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A create that is safe to retry: the same body keeps its key, so a retry after a lost answer finds the row the
 * first try made instead of making a second one. A changed body, a success or a refused key starts a new key.
 */
export function keyedPost() {
  let last: { body: string; key: string } | null = null;
  return async <T>(schema: ZodType<T>, path: string, body: unknown): Promise<T> => {
    const text = JSON.stringify(body);
    if (last?.body !== text) last = { body: text, key: uuidv7() };
    try {
      const answer = await request(schema, path, { method: "POST", body, idempotencyKey: last.key });
      last = null;
      return answer;
    } catch (error) {
      if (error instanceof ApiError && error.details?.reason === "idempotency_key_reused") last = null;
      throw error;
    }
  };
}
