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
import { scopeSetOf } from "@shoutory/provider-sdk/manifest";
import { errorResult, type ProviderResult, type ReadLimit } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { mastodonManifest } from "./manifest.js";

// Built from https://docs.joinmastodon.org/methods/apps/, /spec/oauth/ (discovery document, PKCE S256 from 4.3.0),
// /methods/oauth/, /methods/accounts/, /methods/instance/, /methods/statuses/ and /api/rate-limits/ (all read
// 2026-11-24). Every call goes to the one instance host the channel stored, on paths fixed here: no URL an instance
// answers with (a discovery document's endpoints included) is ever followed.

const SCOPES = scopeSetOf(mastodonManifest);
const CLIENT_NAME = "Shoutory";
const NO_EFFECT = { effect: "none" } as const;
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
// A number beyond these bounds is no limit, whatever the instance says.
const MAX_CHARACTERS = 1_000_000;
const MAX_ATTACHMENTS = 100;
const MAX_IMAGE_BYTES = 16 * 1024 ** 3;
// Each field is read on its own: one the instance leaves out or states beyond bound is left to the manifest.
const limitField = (max: number) => z.int().positive().max(max).optional().catch(undefined);
const instanceAnswer = z
  .object({
    configuration: z
      .object({
        statuses: z
          .object({
            max_characters: limitField(MAX_CHARACTERS),
            max_media_attachments: limitField(MAX_ATTACHMENTS),
            characters_reserved_per_url: limitField(MAX_CHARACTERS),
          })
          .catch({}),
        media_attachments: z.object({ image_size_limit: limitField(MAX_IMAGE_BYTES) }).catch({}),
      })
      .catch({ statuses: {}, media_attachments: {} }),
  })
  .catch({ configuration: { statuses: {}, media_attachments: {} } });
const oauthError = z.object({ error: z.string().max(64) });
// Only these OAuth error codes (RFC 6749 section 5.2) are handed on; any other text an instance sends, including a value
// it echoes back from the request, is never carried into a result.
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

type Found<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false; readonly result: ProviderResult };

const MAX_ANSWER_BYTES = 512 * 1024;

// A body longer than the bound, or one that is not JSON, is no answer: the caller classes it as unusable, never as a status.
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

// A send is told apart from a read (docs.joinmastodon.org/methods/statuses, read 2026-11-24): an answer lost after the
// status may exist (a cut connection, a timeout after the request went out, a 409 or a 5xx) is an unknown outcome, never
// "no effect". A read changes nothing.

// A connection cut after the request may have been read: the status may exist.
const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);
const unknown = (): ProviderResult => errorResult({ effect: "possible", errorClass: "unknown" });

// Anything not classed here is a bug and throws.
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

// Retry-After (seconds or an HTTP date) when a proxy or instance sends one, else the documented X-RateLimit-Reset, an ISO
// time (docs.joinmastodon.org/api/rate-limits, accessed 2026-11-24).
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

// After a send a 409 or a 5xx may follow a created status, so it is unknown. Only a read carries the instance's OAuth code.
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

/** `sent` is true for a call that changes something, whose lost answer is unknown. */
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

type InstanceLimits = Pick<ProviderResult, "limits" | "limitsFromManifest">;

async function instanceLimits(context: AdapterContext, host: string): Promise<Found<InstanceLimits>> {
  const answer = await call(context, host, "/api/v2/instance");
  if (!answer.ok) return { found: false, result: answer.result };
  const { statuses, media_attachments: media } = instanceAnswer.parse(answer.json).configuration;
  const stated = Object.entries({
    textLength: statuses.max_characters,
    urlWeight: statuses.characters_reserved_per_url,
    mediaMaxCount: statuses.max_media_attachments,
    imageMaxBytes: media.image_size_limit,
  });
  const [source, checked] = [`https://${host}/api/v2/instance`, context.now().toISOString().slice(0, 10)];
  const limits: Record<string, ReadLimit> = {};
  for (const [name, value] of stated) if (value !== undefined) limits[name] = { value, source, checked };
  const missing = stated.filter(([, value]) => value === undefined).map(([name]) => name);
  return { found: true, value: { limits, ...(missing.length > 0 ? { limitsFromManifest: missing } : {}) } };
}

// PKCE S256 exists from Mastodon 4.3.0; a fork keeps its own version string, so the discovery document is tested.
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
    ...limits.value,
    identity: {
      // An account id is local to its instance: the same id on two instances is two accounts.
      providerAccountId: `${input.instanceHost}/${id}`,
      accountKind: "profile",
      displayName: shown || username,
      // A local account's acct is its bare username; the instance makes it a full address.
      ...(acct === undefined ? {} : { handle: acct.includes("@") ? acct : `${acct}@${input.instanceHost}` }),
      ...(avatar === undefined ? {} : { avatar }),
    },
  };
}

async function inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult> {
  if (input.instanceHost === undefined) throw new Error("a channel read needs the instance host");
  const who = await verified(context, input.instanceHost, input.accessToken);
  if (!who.found) return who.result;
  const limits = await instanceLimits(context, input.instanceHost);
  return { ok: true, ...NO_EFFECT, health: "ok", ...(limits.found ? limits.value : {}) };
}

const connect: ConnectAdapter = {
  registerApp,
  authorize,
  exchangeCode,
  identity,
};

type ChannelAccess = { readonly accessToken: SealedSecret; readonly instanceHost: string };
const refusedInput = (): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "invalid_input" });
function channelAccessOf(access: AccountAccess | undefined): ChannelAccess | undefined {
  return access?.instanceHost === undefined
    ? undefined
    : { accessToken: access.accessToken, instanceHost: access.instanceHost };
}

const createdStatus = z.object({ id: z.string().min(1).max(64), url: z.string().max(2048).optional() });

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

// An id from an instance goes into a path: only id characters pass, so it cannot name another route or add a query.
const STATUS_ID = /^[A-Za-z0-9_-]{1,64}$/;
function targetOf(post: RemotePost): { readonly id: string; readonly path: string } | undefined {
  const id = post.externalId;
  return id !== undefined && STATUS_ID.test(id) ? { id, path: `/api/v1/statuses/${id}` } : undefined;
}

// A status answered with another id is no answer. A 404 travels on as `httpStatus` and core decides what absence proves
// (the body text is never read). Private and direct statuses are only visible with `read:statuses`.
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

// No `delete_media` is sent. A 5xx or a cut answer may follow a status that was removed, so it is unknown.
async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  if (channel === undefined || target === undefined) return refusedInput();
  const init = { method: "DELETE", headers: bearer(channel.accessToken) };
  const answer = await call(context, channel.instanceHost, target.path, init, true);
  if (answer.ok) return { ok: true, effect: "confirmed" };
  return answer.status === 404 ? goneOrNot(context, channel, target) : answer.result;
}

// A 404 on the delete alone proves nothing (a stale or proxied answer): one read of the same id decides. A post still
// live, or a read that cannot say, is an unknown outcome for a person, never called done.
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

const prepare = async (): Promise<ProviderResult> => ({ ok: true, ...NO_EFFECT });

export function createMastodonAdapter(): ProviderAdapter {
  return { prepare, commit, readBack, delete: remove, inspect, connect };
}
