import { refreshAnswerSchema } from "@shoutory/core/channels";
import { SealedSecret } from "@shoutory/core/crypto";
import type {
  AdapterContext,
  CommitInput,
  InspectInput,
  ProviderAdapter,
  RefreshInput,
  RemotePost,
} from "@shoutory/provider-sdk/adapter";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";

/** What the adapter knows about a failed answer; the fixture network documents a code for each refusal. */
interface FailureInput {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;
  readonly now: Date;
  /** True for a call that can change something at the provider. */
  readonly write: boolean;
}

// A Retry-After header is a whole number of seconds or an HTTP date; anything else is no delay.
function retryDelayMs(value: string, now: Date): number | undefined {
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/** Maps a failed answer to a result. The class follows the situation the provider documents, never the status alone. */
function mapFailure({ status, code, retryAfter, now, write }: FailureInput): ProviderResult {
  if (status === 429) {
    const retryAfterMs = retryAfter === undefined ? undefined : retryDelayMs(retryAfter, now);
    return errorResult({
      effect: "none",
      errorClass: "rate_limited",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status >= 500) {
    return write
      ? errorResult({ effect: "possible", errorClass: "unknown" })
      : errorResult({ effect: "none", errorClass: "retryable_before_send" });
  }
  // A duplicate means an earlier send may have created the post: only a read-back can tell.
  if (code === "duplicate")
    return errorResult({ effect: "possible", errorClass: "unknown", providerCode: code });
  const errorClass = code === "grant_revoked" ? "auth_revoked" : "permanent";
  return errorResult({ effect: "none", errorClass, ...(code === undefined ? {} : { providerCode: code }) });
}

export interface FixtureAdapterOptions {
  /** Where the fixture simulator listens. */
  readonly baseUrl: string;
  /** Replaces the failure mapper; a test passes a wrong one to see the fault matrix refuse it. */
  readonly mapFailure?: typeof mapFailure | undefined;
  /** The OAuth client id of the fixture network; the adapter refreshes tokens (RFC 6749 section 6) only when it is set. */
  readonly clientId?: string | undefined;
}

// The error answer of RFC 6749 section 5.2; the token answer is the bounded schema of core.
const oauthError = z.object({ error: z.string() });

const created = z.object({ id: z.string() });
const failure = z.object({ error: z.object({ code: z.string() }) });

type Answer =
  | { readonly ok: true; readonly json: unknown }
  // `status` is the provider's answer, absent when there was none (a network failure).
  | { readonly ok: false; readonly result: ProviderResult; readonly status?: number };

// The fixture network answers 404 for a post that is not there (the manifest's absent answer).
const ABSENT_STATUS = 404;

// The codes undici and Node give a failure of the connection: one that never opened sent nothing; the others may have
// been cut after the request went out.
const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);
const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);

const networkCode = (error: Error): string | undefined => {
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};

// A network failure. Only a coded one, or a deadline we set, is an outcome to report; anything else is a bug and throws.
function networkFailure(error: unknown, write: boolean): ProviderResult {
  if (!(error instanceof Error)) throw error;
  const code = networkCode(error);
  if (code !== undefined && NOT_SENT.has(code))
    return errorResult({ effect: "none", errorClass: "retryable_before_send" });
  const deadline = error.name === "TimeoutError" || error.name === "AbortError";
  if (!deadline && !(code !== undefined && CUT_OFF.has(code))) throw error;
  return write
    ? errorResult({ effect: "possible", errorClass: "unknown" })
    : errorResult({ effect: "none", errorClass: "retryable_before_send" });
}

function textToJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function request(
  options: FixtureAdapterOptions,
  context: AdapterContext,
  method: string,
  path: string,
  send: { readonly body?: unknown; readonly key?: string; readonly token?: SealedSecret } = {},
): Promise<Answer> {
  const write = method !== "GET";
  try {
    const response = await context.fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        ...(send.body === undefined ? {} : { "content-type": "application/json" }),
        ...(send.key === undefined ? {} : { "idempotency-key": send.key }),
        ...(send.token === undefined ? {} : { authorization: `Bearer ${send.token.expose()}` }),
      },
      ...(send.body === undefined ? {} : { body: JSON.stringify(send.body) }),
    });
    const json = textToJson(await response.text());
    if (response.ok) return { ok: true, json };
    const code = failure.safeParse(json).data?.error.code;
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    const map = options.mapFailure ?? mapFailure;
    return {
      ok: false,
      status: response.status,
      result: map({ status: response.status, code, retryAfter, now: context.now(), write }),
    };
  } catch (error) {
    return { ok: false, result: networkFailure(error, write) };
  }
}

// One refresh-token grant at the token route. A refresh changes nothing at the network (effect none), so a failure is
// never "possible": the class follows the answer, and the provider's own error code is kept for the manifest's map.
async function refreshTokens(
  options: FixtureAdapterOptions & { readonly clientId: string },
  context: AdapterContext,
  input: RefreshInput,
): Promise<ProviderResult> {
  try {
    const response = await context.fetch(`${options.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken.expose(),
        client_id: options.clientId,
      }).toString(),
    });
    const json = textToJson(await response.text());
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      const code = oauthError.safeParse(json).data?.error;
      return (options.mapFailure ?? mapFailure)({
        status: response.status,
        code,
        retryAfter,
        now: context.now(),
        write: false,
      });
    }
    // A success answer that cannot be used may have spent a rotating token: the outcome is unknown, never a refusal.
    const answer = refreshAnswerSchema.safeParse(json);
    if (!answer.success) return errorResult({ effect: "possible", errorClass: "unknown" });
    return {
      ok: true,
      effect: "none",
      credential: {
        accessToken: new SealedSecret(answer.data.access_token),
        ...(answer.data.refresh_token === undefined
          ? {}
          : { refreshToken: new SealedSecret(answer.data.refresh_token) }),
        expiresInSeconds: answer.data.expires_in,
      },
    };
  } catch (error) {
    return networkFailure(error, false);
  }
}

// The read of a channel: the account route with the access token. A success that is not an account may be a garbled
// answer, so what it says of the channel is unknown.
async function inspectAccount(
  options: FixtureAdapterOptions,
  context: AdapterContext,
  input: InspectInput,
): Promise<ProviderResult> {
  const answer = await request(options, context, "GET", "/v1/account", { token: input.accessToken });
  if (!answer.ok) return answer.result;
  const isAccount = typeof answer.json === "object" && answer.json !== null && !Array.isArray(answer.json);
  return isAccount
    ? { ok: true, effect: "none", health: "ok" }
    : errorResult({ effect: "none", errorClass: "unknown" });
}

export function createFixtureAdapter(options: FixtureAdapterOptions): ProviderAdapter {
  const call = (
    context: AdapterContext,
    method: string,
    path: string,
    send?: { readonly body?: unknown; readonly key?: string },
  ) => request(options, context, method, path, send);

  // A success answer must hold an id; one that does not (cut short, or garbled) is an unknown outcome.
  function withId(answer: Answer, effect: "confirmed", write: boolean): ProviderResult {
    if (!answer.ok) return answer.result;
    const id = created.safeParse(answer.json);
    if (id.success) return { ok: true, effect, externalId: id.data.id };
    return errorResult(
      write ? { effect: "possible", errorClass: "unknown" } : { effect: "none", errorClass: "permanent" },
    );
  }

  const target = (post: RemotePost) => `/v1/posts/${encodeURIComponent(post.externalId ?? "")}`;
  const done = (answer: Answer): ProviderResult => (answer.ok ? { ok: true, effect: "none" } : answer.result);

  return {
    prepare: async (context: AdapterContext, input: CommitInput) =>
      done(await call(context, "POST", "/v1/validate", { body: { text: input.text } })),
    commit: async (context, input) =>
      withId(
        await call(context, "POST", "/v1/posts", {
          body: {
            text: input.text,
            ...(input.replyToExternalId === undefined ? {} : { replyTo: input.replyToExternalId }),
          },
          key: input.idempotencyKey,
        }),
        "confirmed",
        true,
      ),
    readBack: async (context, post) => withId(await call(context, "GET", target(post)), "confirmed", false),
    delete: async (context, post) => {
      const answer = await call(context, "DELETE", target(post));
      if (answer.ok) return { ok: true, effect: "confirmed" };
      // A post that is already gone is the state the delete wanted: done, with nothing changed by this call.
      return answer.status === ABSENT_STATUS ? { ok: true, effect: "none" } : answer.result;
    },
    edit: async (context, post, input) =>
      withId(await call(context, "PATCH", target(post), { body: { text: input.text } }), "confirmed", true),
    inspect: (context, input) => inspectAccount(options, context, input),
    ...(options.clientId === undefined
      ? {}
      : {
          refresh: (context: AdapterContext, input: RefreshInput) =>
            refreshTokens({ ...options, clientId: options.clientId as string }, context, input),
        }),
  };
}
