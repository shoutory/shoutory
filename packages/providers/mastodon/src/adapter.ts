import { type CountingRule, countText } from "@shoutory/core/counting";
import { SealedSecret } from "@shoutory/core/crypto";
import {
  type AccountAccess,
  type AdapterContext,
  type AuthorizeInput,
  type AuthorizeResult,
  type CommitInput,
  type ConnectAdapter,
  type ExchangeInput,
  type IdentityInput,
  type InspectInput,
  type MediaFile,
  type MediaItem,
  MediaReadError,
  type MediaReader,
  type PollInput,
  type ProviderAdapter,
  type RegisterAppInput,
  type RemotePost,
  type RevokeInput,
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
  } else if (deadline || CUT_OFF.has(named)) {
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
  readonly body?: string | Uint8Array;
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
  const { instanceHost } = input;
  if (instanceHost === undefined) throw new Error("an app registration needs the instance host");
  const refused = await discover(context, instanceHost);
  if (refused) return refused;
  const answer = await call(
    context,
    instanceHost,
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

async function authorize(_context: AdapterContext, input: AuthorizeInput): Promise<AuthorizeResult> {
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
  return { url: `https://${input.instanceHost}/oauth/authorize?${query}` };
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

// Built from https://docs.joinmastodon.org/methods/oauth/ (POST /oauth/revoke with client_id, client_secret and token;
// 200 with an empty object, 403 when the token was not issued to the app), read 2026-11-27. The message carries the
// status only, never a body or a secret.
async function revoke(context: AdapterContext, input: RevokeInput): Promise<void> {
  if (input.instanceHost === undefined || input.app === undefined) {
    throw new Error("a revoke needs the instance host and its app");
  }
  const answer = await call(
    context,
    input.instanceHost,
    "/oauth/revoke",
    form({
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret.expose(),
      token: input.accessToken.expose(),
    }),
  );
  if (!answer.ok) throw new Error(`the instance refused the revoke (${answer.status ?? "no answer"})`);
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

// What the instance takes besides the text (docs.joinmastodon.org/methods/statuses/, read 2026-11-27). `direct` is not
// offered: a direct status is a message to named people, which this product does not publish.
const postSettings = z.object({
  visibility: z.enum(["default", "public", "unlisted", "private"]).optional(),
  sensitive: z.boolean().optional(),
  spoiler_text: z.string().max(10_000).optional(),
});

// `language` is an ISO 639-1 code: a BCP 47 tag is cut to its two-letter primary subtag and anything else is left out.
function languageOf(locale: string | null | undefined): string | undefined {
  const primary = locale?.split("-")[0]?.toLowerCase();
  return primary !== undefined && /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

// A create leaves out what equals the account's own defaults. An edit states the content warning and sensitivity in
// full (omitting them would keep the old ones) and never the visibility, which an edit cannot change.
function presentationOf(
  { settings, locale }: Pick<CommitInput, "settings" | "locale">,
  edit: boolean,
): Record<string, string | boolean> | undefined {
  const parsed = postSettings.safeParse(settings ?? {});
  if (!parsed.success) return undefined;
  const { visibility = "default", sensitive = false, spoiler_text: warning = "" } = parsed.data;
  const language = languageOf(locale);
  return {
    ...(edit || warning !== "" ? { spoiler_text: warning } : {}),
    ...(edit || sensitive ? { sensitive } : {}),
    ...(edit || visibility === "default" ? {} : { visibility }),
    ...(language === undefined ? {} : { language }),
  };
}

async function commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const channel = channelAccessOf(input.account);
  // An empty key would be sent as no key, and the instance would then create a second status on a resend.
  if (channel === undefined || input.idempotencyKey === "") return refusedInput();
  const presentation = presentationOf(input, false);
  const reply = input.replyToExternalId;
  if (presentation === undefined || (reply !== undefined && !STATUS_ID.test(reply))) return refusedInput();
  const body = {
    status: input.text,
    ...presentation,
    ...(reply === undefined ? {} : { in_reply_to_id: reply }),
    ...(input.mediaIds === undefined || input.mediaIds.length === 0 ? {} : { media_ids: input.mediaIds }),
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

const sourceAnswer = z.object({ id: z.string().min(1).max(64), text: z.string(), spoiler_text: z.string() });

// https://docs.joinmastodon.org/methods/statuses/#source (read 2026-11-27): the plain text and content warning of a
// status, which the status read only gives as HTML.
async function readSource(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  if (channel === undefined || target === undefined) return refusedInput();
  const answer = await call(context, channel.instanceHost, `${target.path}/source`, {
    headers: bearer(channel.accessToken),
  });
  if (!answer.ok) return answer.result;
  const source = sourceAnswer.safeParse(answer.json);
  if (!source.success || source.data.id !== target.id) return unusable();
  return {
    ok: true,
    effect: "none",
    externalId: target.id,
    content: { text: source.data.text, settings: { spoiler_text: source.data.spoiler_text } },
  };
}

// PUT /api/v1/statuses/:id (docs.joinmastodon.org/methods/statuses/, read 2026-11-27) answers the edited status; a 404
// is a status that is missing, private or not the account's. Media is not sent: `media_ids` would replace the set.
// A 5xx or a cut answer may follow an applied edit, and an answer for another status proves nothing, so both are unknown.
async function edit(
  context: AdapterContext,
  post: RemotePost,
  input: Parameters<NonNullable<ProviderAdapter["edit"]>>[2],
): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  const presentation = presentationOf(input, true);
  if (channel === undefined || target === undefined || presentation === undefined) return refusedInput();
  const init = {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(channel.accessToken) },
    body: JSON.stringify({ status: input.text, ...presentation }),
  };
  const answer = await call(context, channel.instanceHost, target.path, init, true);
  if (!answer.ok) return answer.result;
  const status = statusAnswer.safeParse(answer.json);
  if (!status.success || status.data.id !== target.id) return unknown();
  return { ok: true, effect: "confirmed", externalId: target.id };
}

const instanceVersion = z.object({ version: z.string().max(128) }).catch({ version: "" });
const DELETE_MEDIA_FROM = [4, 4, 0] as const;

// `delete_media` exists from 4.4.0 (docs.joinmastodon.org/methods/statuses/, read 2026-11-27). The numeric
// major.minor.patch prefix of the version is compared and a suffix is ignored; a version that does not start that way
// (a fork's own string, or none) gets the plain delete. The read of the version is not a send.
async function deletesMedia(context: AdapterContext, host: string): Promise<boolean> {
  const answer = await call(context, host, "/api/v2/instance");
  if (!answer.ok) return false;
  const parts = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(instanceVersion.parse(answer.json).version);
  if (parts === null) return false;
  const found = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  for (const [index, least] of DELETE_MEDIA_FROM.entries()) {
    const have = found[index] ?? 0;
    if (have !== least) return have > least;
  }
  return true;
}

// A 5xx or a cut answer may follow a status that was removed, so it is unknown.
async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const channel = channelAccessOf(post.account);
  const target = targetOf(post);
  if (channel === undefined || target === undefined) return refusedInput();
  const withMedia = await deletesMedia(context, channel.instanceHost);
  const path = withMedia ? `${target.path}?delete_media=true` : target.path;
  const init = { method: "DELETE", headers: bearer(channel.accessToken) };
  const answer = await call(context, channel.instanceHost, path, init, true);
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

// The limits an attachment is checked against, read from the instance's own answer (docs.joinmastodon.org/methods/instance/,
// `configuration.media_attachments` and `configuration.statuses`, read 2026-11-27). A field the instance leaves out or
// states beyond bound falls back to the manifest's documented value.
const mediaConfiguration = z
  .object({
    configuration: z
      .object({
        statuses: z.object({ max_media_attachments: limitField(MAX_ATTACHMENTS) }).catch({}),
        media_attachments: z
          .object({
            supported_mime_types: z.array(z.string().max(255)).max(64).optional().catch(undefined),
            image_size_limit: limitField(MAX_IMAGE_BYTES),
            video_size_limit: limitField(MAX_IMAGE_BYTES),
            description_limit: limitField(100_000),
          })
          .catch({}),
      })
      .catch({ statuses: {}, media_attachments: {} }),
  })
  .catch({ configuration: { statuses: {}, media_attachments: {} } });

const DEFAULT_DESCRIPTION_LIMIT = 1500;
// Alt text is counted by code point, as the instance does, and a link in it keeps its own length.
const CODE_POINTS: CountingRule = { unit: "weighted", weights: { defaultWeight: 1, ranges: [] } };

interface MediaLimits {
  readonly maxCount: number;
  readonly imageBytes: number;
  readonly videoBytes: number;
  readonly descriptionLength: number;
  readonly mimeTypes: readonly string[] | undefined;
}

async function mediaLimits(context: AdapterContext, host: string): Promise<Found<MediaLimits>> {
  const answer = await call(context, host, "/api/v2/instance");
  if (!answer.ok) return { found: false, result: answer.result };
  const { statuses, media_attachments: media } = mediaConfiguration.parse(answer.json).configuration;
  return {
    found: true,
    value: {
      maxCount: statuses.max_media_attachments ?? mastodonManifest.limits.mediaMaxCount?.value ?? 4,
      imageBytes: media.image_size_limit ?? mastodonManifest.limits.imageMaxBytes?.value ?? 0,
      videoBytes: media.video_size_limit ?? mastodonManifest.limits.videoMaxBytes?.value ?? 0,
      descriptionLength: media.description_limit ?? DEFAULT_DESCRIPTION_LIMIT,
      mimeTypes: media.supported_mime_types,
    },
  };
}

function refusedMedia(items: readonly MediaItem[], limits: MediaLimits): boolean {
  if (items.length > limits.maxCount) return true;
  return items.some((item) => {
    const cap = item.mime.startsWith("video/") ? limits.videoBytes : limits.imageBytes;
    const unsupported = limits.mimeTypes !== undefined && !limits.mimeTypes.includes(item.mime);
    const long = item.altText !== null && countText(CODE_POINTS, item.altText) > limits.descriptionLength;
    return unsupported || item.size > cap || long;
  });
}

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// multipart/form-data (RFC 7578): the file and, when there is one, its description as a form field.
function multipartOf(mime: string, bytes: Uint8Array, description: string | null) {
  const boundary = `shoutory-${globalThis.crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const filename = `upload.${FILE_EXTENSIONS[mime] ?? "bin"}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail =
    description === null
      ? `\r\n--${boundary}--\r\n`
      : `\r\n--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${description}\r\n--${boundary}--\r\n`;
  const [first, last] = [encoder.encode(head), encoder.encode(tail)];
  const body = new Uint8Array(first.length + bytes.length + last.length);
  body.set(first, 0);
  body.set(bytes, first.length);
  body.set(last, first.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const uploadedMedium = z.object({ id: z.string().regex(STATUS_ID) });
const PROCESSING_CHECK_SECONDS = 30;

async function uploadOne(
  context: AdapterContext,
  channel: ChannelAccess,
  media: MediaReader,
  position: number,
): Promise<ProviderResult> {
  const item = media.items[position];
  if (item === undefined) return refusedInput();
  let file: MediaFile;
  try {
    file = await media.read(position);
  } catch (error) {
    if (!(error instanceof MediaReadError)) throw error;
    return errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "media_unavailable" });
  }
  const { body, contentType } = multipartOf(item.mime, file.bytes, file.altText);
  const headers = { "content-type": contentType, ...bearer(channel.accessToken) };
  const answer = await call(context, channel.instanceHost, "/api/v2/media", {
    method: "POST",
    headers,
    body,
  });
  if (!answer.ok) return answer.result;
  const medium = uploadedMedium.safeParse(answer.json);
  if (!medium.success) return unusable();
  const processing =
    answer.status === 202 ? { processing: { checkInSeconds: PROCESSING_CHECK_SECONDS } } : {};
  return { ok: true, ...NO_EFFECT, upload: { mediaId: medium.data.id, ...processing } };
}

// One medium per call, the next one after the ids already stored, so the worker spends a token and checks its lease
// between uploads. Every file is checked against the instance's limits before the first one is sent.
async function prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const media = context.media;
  const done = input.mediaIds?.length ?? 0;
  if (media === undefined || done >= media.items.length) return { ok: true, ...NO_EFFECT };
  const channel = channelAccessOf(input.account);
  if (channel === undefined) return refusedInput();
  // The first step has checked every file, so the later ones do not read the instance again.
  if (done === 0) {
    const limits = await mediaLimits(context, channel.instanceHost);
    if (!limits.found) return limits.result;
    if (refusedMedia(media.items, limits.value)) return refusedInput();
  }
  return uploadOne(context, channel, media, done);
}

// GET /api/v1/media/:id (docs.joinmastodon.org/methods/media/, read 2026-11-27) answers 200 for a ready medium and 206
// while it is being processed. The ids are read one after the other, and the first that is not ready ends the poll. It is
// a read: no answer, whatever its class, has an effect.
async function pollMedia(context: AdapterContext, input: PollInput): Promise<ProviderResult> {
  const channel = channelAccessOf(input.account);
  if (channel === undefined || !input.mediaIds.every((id) => STATUS_ID.test(id))) return refusedInput();
  for (const id of input.mediaIds) {
    const answer = await call(context, channel.instanceHost, `/api/v1/media/${id}`, {
      headers: bearer(channel.accessToken),
    });
    if (!answer.ok) return answer.result;
    if (answer.status === 206)
      return {
        ok: true,
        ...NO_EFFECT,
        mediaPoll: { ready: false, checkInSeconds: PROCESSING_CHECK_SECONDS },
      };
  }
  return { ok: true, ...NO_EFFECT, mediaPoll: { ready: true } };
}

// A status with no content warning reports an empty one, so a frozen version that leaves it unset holds the same.
function settingsWithDefaults(settings: Readonly<Record<string, string | number | boolean>>) {
  const parsed = postSettings.safeParse(settings);
  return parsed.success ? { ...settings, spoiler_text: parsed.data.spoiler_text ?? "" } : settings;
}

export function createMastodonAdapter(): ProviderAdapter {
  return {
    prepare,
    commit,
    pollMedia,
    readBack,
    readSource,
    settingsWithDefaults,
    edit,
    delete: remove,
    inspect,
    revoke,
    connect,
  };
}
