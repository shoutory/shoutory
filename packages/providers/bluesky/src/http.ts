import { isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";

export const NO_EFFECT = { effect: "none" } as const;

export const unknown = (): ProviderResult => errorResult({ effect: "possible", errorClass: "unknown" });
export const unusable = (): ProviderResult => errorResult({ ...NO_EFFECT, errorClass: "unknown" });
export const refused = (providerCode: string): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode });

// A step that cannot go on carries the result the adapter answers with, so the steps before the last one stay flat.
export class Refusal extends Error {
  readonly result: ProviderResult;
  constructor(result: ProviderResult) {
    super("the provider's answer cannot be used");
    this.name = "Refusal";
    this.result = result;
  }
}

export type Reply =
  | {
      readonly ok: true;
      readonly status: number;
      readonly text: string;
      readonly json: unknown;
      readonly headers: Headers;
    }
  | {
      readonly ok: false;
      readonly status: number | undefined;
      readonly json: unknown;
      readonly result: ProviderResult;
      /** The class the egress client gave a call it turned away (`dns`, `blocked_address`, ...), when it did. */
      readonly egress?: string;
    };

const MAX_ANSWER_BYTES = 512 * 1024;

export const textToJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

// A body longer than the bound is no answer: the caller classes it as unusable, never as a status.
async function readText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const readJson = async (response: Response): Promise<unknown> => {
  const text = await readText(response);
  return text === undefined ? undefined : textToJson(text);
};

const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);
const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);

// `sent` is true for a call that changes something: a connection lost after it went out leaves the outcome unknown.
// Anything not classed here is a bug and throws.
function networkFailure(error: unknown, sent: boolean): ProviderResult {
  if (isPolicyRefusal(error)) return refused("address_not_allowed");
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const named = typeof code === "string" ? code : "";
  const beforeSend = errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" });
  if (NOT_SENT.has(named)) return beforeSend;
  const deadline = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (deadline || CUT_OFF.has(named)) return sent ? unknown() : beforeSend;
  throw error;
}

// Retry-After is seconds or an HTTP date (RFC 9110 section 10.2.3); a value that is neither is no delay.
function delayMs(headers: Headers, now: Date): number | undefined {
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  if (/^\d+$/.test(after)) return Number(after) * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

const TOKEN_ERRORS = new Set(["ExpiredToken", "InvalidToken", "AuthenticationRequired", "invalid_token"]);

export function errorName(json: unknown): string | undefined {
  const name = typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
  return typeof name === "string" ? name : undefined;
}

// The error name an XRPC or OAuth answer carries is a short documented code; nothing else of the body is read.
function failureOf(response: Response, json: unknown, now: Date, sent: boolean): ProviderResult {
  const { status, headers } = response;
  const name = errorName(json);
  const code = name === undefined ? {} : { providerCode: name };
  if (status === 429) {
    const delay = delayMs(headers, now);
    const limited = errorResult({
      ...NO_EFFECT,
      errorClass: "rate_limited",
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
    return sent ? { ...limited, httpStatus: 429 } : limited;
  }
  if (status >= 500 || (sent && status === 409)) {
    const failed = sent
      ? unknown()
      : errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send", ...code });
    return { ...failed, httpStatus: status };
  }
  const revoked = status === 401 || (name !== undefined && TOKEN_ERRORS.has(name));
  const errorClass = revoked ? "auth_revoked" : "permanent";
  return { ...errorResult({ ...NO_EFFECT, errorClass, ...code }), httpStatus: status };
}

/** Runs one request and answers it as a reply: a success, or the result its failure is. */
export async function call(now: () => Date, send: () => Promise<Response>, sent = false): Promise<Reply> {
  try {
    const response = await send();
    const text = await readText(response);
    const json = text === undefined ? undefined : textToJson(text);
    if (response.ok && text !== undefined) {
      return { ok: true, status: response.status, text, json, headers: response.headers };
    }
    const result = response.ok ? (sent ? unknown() : unusable()) : failureOf(response, json, now(), sent);
    return { ok: false, status: response.status, json, result };
  } catch (error) {
    const egress = (error instanceof Error ? (error.cause as { egress?: unknown } | undefined) : undefined)
      ?.egress;
    const result = networkFailure(error, sent);
    return {
      ok: false,
      status: undefined,
      json: undefined,
      result,
      ...(typeof egress === "string" ? { egress } : {}),
    };
  }
}
