import { SealedSecret } from "@shoutory/core/crypto";
import type {
  AdapterContext,
  AuthorizeInput,
  ConnectAdapter,
  ExchangeInput,
  IdentityInput,
  InspectInput,
  ProviderAdapter,
  RegisterAppInput,
} from "@shoutory/provider-sdk/adapter";
import { isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult, type ProviderResult, type ReadLimit } from "@shoutory/provider-sdk/result";
import { z } from "zod";

// The Mastodon API as docs.joinmastodon.org documents it (pages read 2026-11-24): `methods/apps` (register an app),
// `spec/oauth` (the discovery document, the authorization code flow with PKCE S256, from 4.3.0), `methods/oauth` (the
// token route), `methods/accounts` (verify_credentials) and `methods/instance` (the v2 instance answer). Every call goes
// to the one instance host the channel stored, through the fetch of the context, on paths fixed here: no URL an instance
// answers with (a discovery document's endpoints included) is ever followed.

const SCOPES = "read:accounts write:statuses write:media";
const CLIENT_NAME = "Shoutory";
const NO_EFFECT = { effect: "none" } as const;

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

type Reply =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | { readonly ok: false; readonly status: number | undefined; readonly result: ProviderResult };

/** What a read found, or the failure result to answer with. */
type Found<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false; readonly result: ProviderResult };

// The codes undici and Node give a failure of the connection before anything was sent.
const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);

const textToJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

// A failure of the network: a refused address is a permanent answer for this host, an unreachable one may be retried,
// anything else is a bug and throws. Nothing here sends a change, so the effect is always none.
function networkFailure(error: unknown): ProviderResult {
  if (isPolicyRefusal(error)) {
    return errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "address_not_allowed" });
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const deadline = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (deadline || (typeof code === "string" && (NOT_SENT.has(code) || code === "ECONNRESET"))) {
    return errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" });
  }
  throw error;
}

// The class of a failed answer, by the status alone: a refusal of the token is a revoked one, a refusal of the call is
// permanent, and a busy or broken instance is retried.
function failureOf(status: number, retryAfter: string | null, providerCode?: string): ProviderResult {
  const code = providerCode === undefined ? {} : { providerCode };
  if (status === 429) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
    return errorResult({
      ...NO_EFFECT,
      errorClass: "rate_limited",
      ...(seconds === undefined ? {} : { retryAfterMs: seconds }),
    });
  }
  if (status >= 500) return errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send", ...code });
  if (status === 401)
    return { ...errorResult({ ...NO_EFFECT, errorClass: "auth_revoked", ...code }), httpStatus: 401 };
  return { ...errorResult({ ...NO_EFFECT, errorClass: "permanent", ...code }), httpStatus: status };
}

async function call(
  context: AdapterContext,
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  try {
    const response = await context.fetch(`https://${host}${path}`, init);
    const json = textToJson(await response.text());
    if (response.ok) return { ok: true, status: response.status, json };
    const code = oauthError.safeParse(json).data?.error;
    return {
      ok: false,
      status: response.status,
      result: failureOf(response.status, response.headers.get("retry-after"), code),
    };
  } catch (error) {
    return { ok: false, status: undefined, result: networkFailure(error) };
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

// Publishing arrives with its own parts (commit, read-back, delete, media); until then each refuses with no effect.
const notYet = async (): Promise<ProviderResult> =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "not_implemented" });

const connect: ConnectAdapter = {
  registerApp,
  authorize,
  exchangeCode,
  identity,
};

export function createMastodonAdapter(): ProviderAdapter {
  return { prepare: notYet, commit: notYet, readBack: notYet, delete: notYet, inspect, connect };
}
