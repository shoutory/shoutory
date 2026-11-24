import { SealedSecret } from "@shoutory/core/crypto";
import type {
  AccountAccess,
  AdapterContext,
  AuthorizeInput,
  CommitInput,
  ConnectAdapter,
  ExchangeInput,
  IdentityInput,
  InspectInput,
  ProviderAdapter,
  RegisterAppInput,
  RemotePost,
} from "@shoutory/provider-sdk/adapter";
import { isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult, type ProviderResult, type ReadLimit } from "@shoutory/provider-sdk/result";
import { z } from "zod";

// The Mastodon API as docs.joinmastodon.org documents it (pages read 2026-11-24): `methods/apps` (register an app),
// `spec/oauth` (the discovery document, the authorization code flow with PKCE S256, from 4.3.0), `methods/oauth` (the
// token route), `methods/accounts` (verify_credentials) and `methods/instance` (the v2 instance answer). Every call goes
// to the one instance host the channel stored, through the fetch of the context, on paths fixed here: no URL an instance
// answers with (a discovery document's endpoints included) is ever followed.

const SCOPES = "read:accounts read:statuses write:statuses write:media";
const CLIENT_NAME = "Shoutory";
const NO_EFFECT = { effect: "none" } as const;
// The codes undici and Node give a failure of the connection before anything was sent.
const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);

const discoveryDocument = z.object({ code_challenge_methods_supported: z.array(z.string()).max(16) });
const registeredApp = z.object({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(1024),
});
const tokenAnswer = z.object({ access_token: z.string().min(1).max(4096) });
const account = z.object({
  id: z.string().min(1).max(64),
  username: z.string().min(1).max(256),
  acct: z.string().max(512).optional(),
  display_name: z.string().max(512).optional(),
  avatar: z.string().max(2048).optional(),
});
// A limit an instance states is bounded (AGENTS 6.6): a number beyond its bound is no limit, whatever the instance says.
const MAX_CHARACTERS = 1_000_000;
const MAX_ATTACHMENTS = 100;
const MAX_IMAGE_BYTES = 16 * 1024 ** 3;
const instanceAnswer = z.object({
  configuration: z.object({
    statuses: z.object({
      max_characters: z.int().positive().max(MAX_CHARACTERS),
      max_media_attachments: z.int().positive().max(MAX_ATTACHMENTS),
      characters_reserved_per_url: z.int().positive().max(MAX_CHARACTERS),
    }),
    media_attachments: z.object({ image_size_limit: z.int().positive().max(MAX_IMAGE_BYTES) }),
  }),
});
const oauthError = z.object({ error: z.string().max(64) });
// The codes of RFC 6749 section 5.2, the only error texts an instance's answer is allowed to hand on as a provider code:
// any other text (a message, or a value an instance echoes back from the request) is never carried into a result.
const OAUTH_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

type Reply =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | { readonly ok: false; readonly status: number | undefined; readonly result: ProviderResult };

/** What a read found, or the failure result to answer with. */
type Found<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false; readonly result: ProviderResult };

const MAX_ANSWER_BYTES = 512 * 1024;

// The answer's body as JSON, read up to the bound: a longer body (or one that is not JSON) is no answer, so it is
// `undefined` and the caller classes it as unusable, never as a status. The rest of the stream is dropped, not read.
async function answerJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
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
  return textToJson(Buffer.concat(chunks).toString("utf8"));
}

const textToJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

// A send is told apart from a read (docs.joinmastodon.org/methods/statuses, read 2026-11-24): an answer that can be lost
// after the status exists (a cut connection, a timeout after the request went out, a 409 or a 5xx) is an unknown outcome,
// never "no effect". A read changes nothing, so its effect is always none. A refusal before the request left, or one the
// instance gave as its answer (401, 403, 404, 422, 429), is no effect for both.

// The codes of a connection cut after the request may have been read: the status may exist.
const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);
const unknown = (): ProviderResult => errorResult({ effect: "possible", errorClass: "unknown" });

// A failure of the network: a refused address is a permanent answer for this host, an unreachable one may be retried, a
// send that may have left is unknown, anything else is a bug and throws.
function networkFailure(error: unknown, sent: boolean): ProviderResult {
  if (isPolicyRefusal(error)) {
    return errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "address_not_allowed" });
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const named = typeof code === "string" ? code : "";
  const beforeSend = errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" });
  if (NOT_SENT.has(named)) return beforeSend;
  const deadline = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (sent) {
    if (deadline || CUT_OFF.has(named)) return unknown();
  } else if (deadline || named === "ECONNRESET") {
    return beforeSend;
  }
  throw error;
}

// The delay of a 429: a Retry-After (whole seconds or an HTTP date, RFC 9110 10.2.3) a proxy or instance may send, else the
// documented X-RateLimit-Reset (an ISO time, docs.joinmastodon.org/api/rate-limits, accessed 2026-11-24), as the time
// left; none when neither reads.
function delayMs(headers: Headers, now: Date): number | undefined {
  const after = headers.get("retry-after");
  if (after !== null && /^\d+$/.test(after)) return Number(after) * 1000;
  const at = [after, headers.get("x-ratelimit-reset")]
    .map((value) => (value === null ? Number.NaN : Date.parse(value)))
    .find((time) => !Number.isNaN(time));
  return at === undefined ? undefined : Math.max(0, at - now.getTime());
}

function rateLimited(headers: Headers, now: Date): ProviderResult {
  const delay = delayMs(headers, now);
  return errorResult({
    ...NO_EFFECT,
    errorClass: "rate_limited",
    ...(delay === undefined ? {} : { retryAfterMs: delay }),
  });
}

// The class of a failed answer, by the status alone: a refusal of the token is a revoked one, a refusal of the call is
// permanent, and a busy or broken instance is retried; after a send a 409 or a 5xx may follow a created status, so it is
// unknown. Only a read carries the instance's OAuth code.
function failureOf(
  status: number,
  headers: Headers,
  now: Date,
  sent: boolean,
  providerCode?: string,
): ProviderResult {
  const code = providerCode === undefined ? {} : { providerCode };
  if (status === 429) return { ...rateLimited(headers, now), ...(sent ? { httpStatus: 429 } : {}) };
  if (sent && (status === 409 || status >= 500)) return { ...unknown(), httpStatus: status };
  if (status >= 500) return errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send", ...code });
  const errorClass = status === 401 ? "auth_revoked" : "permanent";
  return { ...errorResult({ ...NO_EFFECT, errorClass, ...code }), httpStatus: status };
}

const oauthCodeOf = (json: unknown): string | undefined => {
  const text = oauthError.safeParse(json).data?.error;
  return text !== undefined && OAUTH_CODES.has(text) ? text : undefined;
};

interface CallInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** The one request of the adapter: `sent` is true for a call that changes something, whose lost answer is unknown. */
async function call(
  context: AdapterContext,
  host: string,
  path: string,
  init: CallInit = {},
  sent = false,
): Promise<Reply> {
  try {
    const response = await context.fetch(`https://${host}${path}`, init);
    const json = await answerJson(response);
    if (response.ok) return { ok: true, status: response.status, json };
    const code = sent ? undefined : oauthCodeOf(json);
    const result = failureOf(response.status, response.headers, context.now(), sent, code);
    return { ok: false, status: response.status, result };
  } catch (error) {
    return { ok: false, status: undefined, result: networkFailure(error, sent) };
  }
}

const unusable = (): ProviderResult => errorResult({ ...NO_EFFECT, errorClass: "unknown" });
const unsupported = (): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "instance_unsupported" });
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const bearer = (token: SealedSecret) => ({ authorization: `Bearer ${token.expose()}` });

// The instance's own limits, each with the page it was read from and the day (never the documented default).
async function instanceLimits(
  context: AdapterContext,
  host: string,
): Promise<Found<Record<string, ReadLimit>>> {
  const answer = await call(context, host, "/api/v2/instance");
  if (!answer.ok) return { found: false, result: answer.result };
  const parsed = instanceAnswer.safeParse(answer.json);
  if (!parsed.success) return { found: false, result: unusable() };
  const { statuses, media_attachments: media } = parsed.data.configuration;
  const [source, checked] = [`https://${host}/api/v2/instance`, context.now().toISOString().slice(0, 10)];
  const limit = (value: number): ReadLimit => ({ value, source, checked });
  return {
    found: true,
    value: {
      textLength: limit(statuses.max_characters),
      urlWeight: limit(statuses.characters_reserved_per_url),
      mediaMaxCount: limit(statuses.max_media_attachments),
      imageMaxBytes: limit(media.image_size_limit),
    },
  };
}

// The instance can take part in a connect only when its discovery document lists S256 (4.3.0 and later; a fork keeps its
// own version string, so the feature is tested, not the version).
async function discover(context: AdapterContext, host: string): Promise<ProviderResult | undefined> {
  const answer = await call(context, host, "/.well-known/oauth-authorization-server");
  if (!answer.ok) return answer.status === 404 ? unsupported() : answer.result;
  const document = discoveryDocument.safeParse(answer.json);
  return document.success && document.data.code_challenge_methods_supported.includes("S256")
    ? undefined
    : unsupported();
}

async function registerApp(context: AdapterContext, input: RegisterAppInput): Promise<ProviderResult> {
  const refused = await discover(context, input.instanceHost);
  if (refused) return refused;
  const answer = await call(
    context,
    input.instanceHost,
    "/api/v1/apps",
    form({ client_name: CLIENT_NAME, redirect_uris: input.redirectUri, scopes: SCOPES }),
  );
  if (!answer.ok) return answer.result;
  const app = registeredApp.safeParse(answer.json);
  if (!app.success) return unusable();
  return {
    ok: true,
    ...NO_EFFECT,
    app: { clientId: app.data.client_id, clientSecret: new SealedSecret(app.data.client_secret) },
  };
}

function authorize(input: AuthorizeInput): string {
  if (input.instanceHost === undefined || input.app === undefined) {
    throw new Error("an authorization needs the instance host and its app");
  }
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.app.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://${input.instanceHost}/oauth/authorize?${query}`;
}

async function exchangeCode(context: AdapterContext, input: ExchangeInput): Promise<ProviderResult> {
  if (input.instanceHost === undefined || input.app === undefined) {
    throw new Error("a code exchange needs the instance host and its app");
  }
  const answer = await call(
    context,
    input.instanceHost,
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret.expose(),
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier.expose(),
      scope: SCOPES,
    }),
  );
  if (!answer.ok) return answer.result;
  const token = tokenAnswer.safeParse(answer.json);
  if (!token.success) return unusable();
  return {
    ok: true,
    ...NO_EFFECT,
    // The instance's token never expires and has no refresh token, so no lifetime is stated and none is stored.
    credential: { accessToken: new SealedSecret(token.data.access_token) },
  };
}

// verify_credentials: the account the token belongs to. A body that is no account is never read as one.
async function verified(
  context: AdapterContext,
  host: string,
  token: SealedSecret,
): Promise<Found<z.infer<typeof account>>> {
  const answer = await call(context, host, "/api/v1/accounts/verify_credentials", { headers: bearer(token) });
  if (!answer.ok) return { found: false, result: answer.result };
  const parsed = account.safeParse(answer.json);
  return parsed.success ? { found: true, value: parsed.data } : { found: false, result: unusable() };
}

async function identity(context: AdapterContext, input: IdentityInput): Promise<ProviderResult> {
  if (input.instanceHost === undefined) throw new Error("an identity read needs the instance host");
  const who = await verified(context, input.instanceHost, input.accessToken);
  if (!who.found) return who.result;
  const limits = await instanceLimits(context, input.instanceHost);
  if (!limits.found) return limits.result;
  const { id, username, acct, display_name: shown, avatar } = who.value;
  return {
    ok: true,
    ...NO_EFFECT,
    limits: limits.value,
    identity: {
      // An account id is local to its instance, so the channel's identity is the instance and the id together: the same
      // id on two instances is two accounts, and an instance can never name a channel it does not own.
      providerAccountId: `${input.instanceHost}/${id}`,
      accountKind: "profile",
      displayName: shown || username,
      ...(acct === undefined ? {} : { handle: acct }),
      ...(avatar === undefined ? {} : { avatar }),
    },
  };
}

// The health of a channel is what verify_credentials says of its token; the instance's limits ride along when it states them.
async function inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult> {
  if (input.instanceHost === undefined) throw new Error("a channel read needs the instance host");
  const who = await verified(context, input.instanceHost, input.accessToken);
  if (!who.found) return who.result;
  const limits = await instanceLimits(context, input.instanceHost);
  return { ok: true, ...NO_EFFECT, health: "ok", ...(limits.found ? { limits: limits.value } : {}) };
}

const connect: ConnectAdapter = {
  registerApp,
  authorize,
  exchangeCode,
  identity,
};

// ---- Publishing (docs.joinmastodon.org/methods/statuses, read 2026-11-24) ----
// A call that changes something goes through `call` with `sent` set; a lost answer to it is an unknown outcome, and a body
// that holds no status may follow a created one.

/** The channel's token and its stored host, both present, or the refusal that nothing was sent (no effect). */
type ChannelAccess = { readonly accessToken: SealedSecret; readonly instanceHost: string };
const refusedInput = (): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "invalid_input" });
function channelAccessOf(access: AccountAccess | undefined): ChannelAccess | undefined {
  return access?.instanceHost === undefined
    ? undefined
    : { accessToken: access.accessToken, instanceHost: access.instanceHost };
}

const createdStatus = z.object({ id: z.string().min(1).max(64), url: z.string().max(2048).optional() });

// The key is the one the caller gave, the same on every send of the operation (the instance keeps it for up to an hour).
async function commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const channel = channelAccessOf(input.account);
  // An empty key would be sent as no key, and the instance would then create a second status on a resend.
  if (channel === undefined || input.idempotencyKey === "") return refusedInput();
  const body = {
    status: input.text,
    ...(input.replyToExternalId === undefined ? {} : { in_reply_to_id: input.replyToExternalId }),
  };
  const headers = {
    "content-type": "application/json",
    "idempotency-key": input.idempotencyKey,
    ...bearer(channel.accessToken),
  };
  const answer = await call(
    context,
    channel.instanceHost,
    "/api/v1/statuses",
    { method: "POST", headers, body: JSON.stringify(body) },
    true,
  );
  if (!answer.ok) return answer.result;
  // A 200 that holds no status may have created one: the id is read from the answer or the outcome is unknown.
  const status = createdStatus.safeParse(answer.json);
  if (!status.success) return unknown();
  return {
    ok: true,
    effect: "confirmed",
    externalId: status.data.id,
    ...(status.data.url === undefined ? {} : { permalink: status.data.url }),
  };
}

const statusAnswer = z.object({ id: z.string().min(1).max(64) });

// An id came from an instance and is put in a path: only the characters an id is made of are let through, so no id can
// name another route, climb out of the statuses path or add a query.
const STATUS_ID = /^[A-Za-z0-9_-]{1,64}$/;
function targetOf(post: RemotePost): { readonly id: string; readonly path: string } | undefined {
  const id = post.externalId;
  return id !== undefined && STATUS_ID.test(id) ? { id, path: `/api/v1/statuses/${id}` } : undefined;
}

// A read-back names the id it was asked for and nothing else: the id of the answer is never taken as the post's, and a
// status the instance answers with another id is no answer. A 404 is the instance saying the status is not there; its
// status travels on as `httpStatus` and core decides what absence proves (the body text is never read). Private and
// direct statuses are only visible with `read:statuses`.
async function readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  if (channel === undefined || target === undefined) return refusedInput();
  const answer = await call(context, channel.instanceHost, target.path, {
    headers: bearer(channel.accessToken),
  });
  if (!answer.ok) return answer.result;
  const status = statusAnswer.safeParse(answer.json);
  if (!status.success || status.data.id !== target.id) return unusable();
  return { ok: true, effect: "confirmed", externalId: target.id };
}

// A delete names the one id and sends nothing else (no `delete_media`: media ship with their own part). The instance's 200
// is the effect; its 404 says the status is not there, which is what the delete wanted: done, with nothing changed by
// this call. A 5xx or a cut answer may follow a status that was removed, so it is unknown.
async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  if (channel === undefined || target === undefined) return refusedInput();
  const init = { method: "DELETE", headers: bearer(channel.accessToken) };
  const answer = await call(context, channel.instanceHost, target.path, init, true);
  if (answer.ok) return { ok: true, effect: "confirmed" };
  return answer.status === 404 ? goneOrNot(context, channel, target) : answer.result;
}

// A 404 on the delete alone proves nothing (a stale or proxied answer): one read of the same id decides. Its 404 means the
// post is gone, done with nothing changed by this call. Its 200 means the post is still live, and a read that cannot say
// leaves it unsaid: both are an unknown outcome, which the ledger hands to a person, and neither is ever called done.
async function goneOrNot(
  context: AdapterContext,
  channel: ChannelAccess,
  target: { readonly id: string; readonly path: string },
): Promise<ProviderResult> {
  const read = await call(context, channel.instanceHost, target.path, {
    headers: bearer(channel.accessToken),
  });
  if (!read.ok) return read.status === 404 ? { ok: true, ...NO_EFFECT } : unknown();
  const live = statusAnswer.safeParse(read.json);
  return live.success && live.data.id === target.id
    ? errorResult({ effect: "possible", errorClass: "unknown", providerCode: "still_present" })
    : unknown();
}

// The post is validated by the create itself: this step only passes.
const prepare = async (): Promise<ProviderResult> => ({ ok: true, ...NO_EFFECT });

export function createMastodonAdapter(): ProviderAdapter {
  return { prepare, commit, readBack, delete: remove, inspect, connect };
}
