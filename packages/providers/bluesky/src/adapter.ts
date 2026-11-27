import { createHash } from "node:crypto";
import { countText } from "@shoutory/core/counting";
import { SealedSecret } from "@shoutory/core/crypto";
import {
  type AccountAccess,
  type AdapterContext,
  type AuthorizeInput,
  type AuthorizeResult,
  type CommitInput,
  type ConnectAdapter,
  type ExchangeInput,
  type InspectInput,
  type MediaFile,
  type MediaItem,
  MediaReadError,
  type MediaReader,
  type ProviderAdapter,
  type PublicDocumentsInput,
  type RefreshInput,
  type RegisterAppInput,
  type RemotePost,
} from "@shoutory/provider-sdk/adapter";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { detectFacets } from "./facets.js";
import {
  call,
  errorName,
  NO_EFFECT,
  Refusal,
  type Reply,
  refused,
  textToJson,
  unknown,
  unusable,
} from "./http.js";
import { authorizationServerOf, resolveHandle, resolveLogin } from "./identity.js";
import { blueskyManifest } from "./manifest.js";
import {
  appKeyOf,
  discoverServer,
  dpopFetch,
  keyOf,
  newKey,
  type PrivateJwk,
  publicOf,
  pushAuthorization,
  SCOPE,
  thumbprint,
  tokenGrant,
  tokenOf,
} from "./oauth.js";

// Built from https://atproto.com/specs/oauth, /specs/handle, /specs/did, /specs/tid and /specs/record-key (all read
// 2026-11-27). The client is confidential: its one key belongs to the instance and its public part is served at the
// documents below. Every call goes to a host a DID document or a protected-resource document named, over the one egress
// policy; nothing an answer holds is followed as a URL.

const DOCUMENTS = "/api/v1/provider-documents/bluesky";
const CLIENT_METADATA = "client-metadata.json";
const JWKS = "jwks.json";

const refusedInput = () => refused("invalid_input");

// One key for the whole instance, made here and sealed by the caller as the instance app.
async function registerApp(_context: AdapterContext, input: RegisterAppInput): Promise<ProviderResult> {
  const origin = new URL(input.redirectUri).origin;
  return {
    ok: true,
    ...NO_EFFECT,
    app: {
      clientId: `${origin}${DOCUMENTS}/${CLIENT_METADATA}`,
      clientSecret: new SealedSecret(JSON.stringify(newKey())),
    },
  };
}

// The documents the authorization server fetches (https://atproto.com/specs/oauth, client metadata): public members only.
async function publicDocuments({ publicOrigin, app }: PublicDocumentsInput) {
  if (app === undefined) return {};
  const key = appKeyOf(app);
  return {
    [CLIENT_METADATA]: {
      client_id: app.clientId,
      client_name: "Shoutory",
      client_uri: publicOrigin,
      application_type: "web",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
      redirect_uris: [`${publicOrigin}/api/v1/connect/bluesky/callback`],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "ES256",
      dpop_bound_access_tokens: true,
      jwks_uri: `${publicOrigin}${DOCUMENTS}/${JWKS}`,
    },
    [JWKS]: { keys: [{ ...publicOf(key), kid: thumbprint(key), use: "sig", alg: "ES256" }] },
  };
}

async function authorize(
  context: AdapterContext,
  input: AuthorizeInput,
): Promise<AuthorizeResult | ProviderResult> {
  const { app, loginHint } = input;
  if (app === undefined || loginHint === undefined) return refusedInput();
  try {
    const account = await resolveLogin(context, loginHint);
    const server = await discoverServer(context, await authorizationServerOf(context, account.pds));
    const dpopKey = newKey();
    const requestUri = await pushAuthorization(context, {
      server,
      app,
      dpopKey,
      state: input.state,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      loginHint: account.handle ?? account.did,
    });
    const query = new URLSearchParams({ client_id: app.clientId, request_uri: requestUri });
    return {
      url: `${server.authorizationEndpoint}?${query}`,
      requestUri,
      dpopKey: new SealedSecret(JSON.stringify(dpopKey)),
      issuer: server.issuer,
    };
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    throw error;
  }
}

const profileRecord = z.object({ value: z.object({ displayName: z.string().max(640).optional() }) });

// The name shown for the account. The profile record is cosmetic, so an answer that is not a usable profile leaves the
// handle (or the DID) as the name; the grant itself has already been checked.
async function displayNameOf(
  context: AdapterContext,
  account: { readonly did: string; readonly pds: string; readonly handle?: string | undefined },
  grant: { readonly accessToken: string; readonly key: ReturnType<typeof keyOf> },
): Promise<string> {
  const query = new URLSearchParams({
    repo: account.did,
    collection: "app.bsky.actor.profile",
    rkey: "self",
  });
  const url = `https://${account.pds}/xrpc/com.atproto.repo.getRecord?${query}`;
  const reply = await call(context.now, () =>
    dpopFetch(context, { key: grant.key, url, init: { method: "GET" }, accessToken: grant.accessToken }),
  );
  const parsed = reply.ok ? profileRecord.safeParse(reply.json) : undefined;
  return parsed?.success && parsed.data.value.displayName
    ? parsed.data.value.displayName
    : (account.handle ?? account.did);
}

async function exchangeCode(context: AdapterContext, input: ExchangeInput): Promise<ProviderResult> {
  const { app, dpopKey, issuer, loginHint } = input;
  if (app === undefined || dpopKey === undefined || issuer === undefined || loginHint === undefined) {
    return refusedInput();
  }
  try {
    const account = await resolveLogin(context, loginHint);
    // The PDS must name the authorization server the sign-in went through, whatever that server says of itself.
    if ((await authorizationServerOf(context, account.pds)) !== issuer) return refused("issuer_mismatch");
    const key = keyOf(dpopKey);
    const grant = {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier.expose(),
      redirect_uri: input.redirectUri,
    };
    const server = await discoverServer(context, issuer);
    const reply = await tokenGrant(context, { server, app, dpopKey: key, grant });
    if (!reply.ok) return reply.result;
    const token = tokenOf(reply);
    if (token.sub !== account.did) return refused("sub_mismatch");
    const displayName = await displayNameOf(context, account, { accessToken: token.access_token, key });
    return {
      ok: true,
      ...NO_EFFECT,
      credential: {
        accessToken: new SealedSecret(token.access_token),
        ...(token.refresh_token === undefined ? {} : { refreshToken: new SealedSecret(token.refresh_token) }),
        ...(token.expires_in === undefined ? {} : { expiresInSeconds: token.expires_in }),
        dpopPrivateJwk: dpopKey,
        issuer,
      },
      identity: {
        providerAccountId: account.did,
        accountKind: "profile",
        displayName,
        instanceHost: account.pds,
        ...(account.handle === undefined ? {} : { handle: account.handle }),
      },
    };
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    throw error;
  }
}

const connect: ConnectAdapter = {
  appKind: "provider",
  registerApp,
  authorize,
  exchangeCode,
  publicDocuments,
};

const POST_COLLECTION = "app.bsky.feed.post";
const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

// A record key is a TID (https://atproto.com/specs/tid, read 2026-11-27): 13 characters of the base32-sortable alphabet
// with the top bit zero. The client chooses it, so it is made from the operation's marker: one marker always names one
// record, and a lost answer is settled by reading that key back.
function rkeyOf(marker: string): string {
  let value = createHash("sha256").update(marker).digest().readBigUInt64BE(0) & ((1n << 63n) - 1n);
  let key = "";
  for (let place = 0; place < 13; place += 1) {
    key = `${ALPHABET[Number(value & 31n)]}${key}`;
    value >>= 5n;
  }
  return key;
}

interface Access {
  readonly did: string;
  readonly host: string;
  readonly token: string;
  readonly key: PrivateJwk;
}

function accessOf(account: AccountAccess | undefined): Access | undefined {
  if (account?.instanceHost === undefined || account.providerAccountId === undefined) return undefined;
  if (account.dpopKey === undefined) return undefined;
  return {
    did: account.providerAccountId,
    host: account.instanceHost,
    token: account.accessToken.expose(),
    key: keyOf(account.dpopKey),
  };
}

interface XrpcInit {
  readonly method: "GET" | "POST";
  readonly query?: Record<string, string>;
  readonly json?: unknown;
  readonly raw?: { readonly bytes: Uint8Array; readonly mime: string };
}

// An XRPC call to the account's PDS, bound to the account's key. `sent` marks a call that changes something.
function xrpc(context: AdapterContext, access: Access, name: string, init: XrpcInit, sent: boolean) {
  const query = init.query === undefined ? "" : `?${new URLSearchParams(init.query)}`;
  const url = `https://${access.host}/xrpc/${name}${query}`;
  const body = init.raw?.bytes ?? (init.json === undefined ? undefined : JSON.stringify(init.json));
  const contentType = init.raw?.mime ?? (init.json === undefined ? undefined : "application/json");
  const headers = contentType === undefined ? undefined : { "content-type": contentType };
  const request = {
    key: access.key,
    url,
    accessToken: access.token,
    init: { method: init.method, ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }) },
  };
  return call(context.now, () => dpopFetch(context, request), sent);
}

const uriOf = (did: string, rkey: string) => `at://${did}/${POST_COLLECTION}/${rkey}`;
const permalinkOf = (did: string, rkey: string) => `https://bsky.app/profile/${did}/post/${rkey}`;

const recordAnswer = z.object({ uri: z.string().max(512), cid: z.string().min(1).max(256) });
const blobRef = z.object({
  $type: z.literal("blob"),
  ref: z.object({ $link: z.string().min(1).max(256) }),
  mimeType: z.string().max(255),
  size: z.int().nonnegative(),
});
const uploadAnswer = z.object({ blob: blobRef });

const withinLimits = (text: string): boolean =>
  countText(blueskyManifest.counting, text) <= (blueskyManifest.limits.textLength?.value ?? 0) &&
  countText({ unit: "bytes" }, text) <= (blueskyManifest.limits.textBytes?.value ?? 0);

function languageOf(locale: string | null | undefined): string | undefined {
  const primary = locale?.split("-")[0]?.toLowerCase();
  return primary !== undefined && /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

// The record a reply names: the parent's `uri` and `cid`, and the root of its thread (the parent's own root, or the
// parent when it starts the thread).
async function replyRefs(context: AdapterContext, access: Access, parentUri: string) {
  const parsed = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(parentUri);
  if (parsed === null || parsed[1] !== access.did) throw new Refusal(refusedInput());
  const query = { repo: access.did, collection: POST_COLLECTION, rkey: parsed[2] ?? "" };
  const read = await xrpc(context, access, "com.atproto.repo.getRecord", { method: "GET", query }, false);
  if (!read.ok) throw new Refusal(read.result);
  const parent = recordRead.safeParse(read.json);
  if (!parent.success || parent.data.uri !== parentUri) throw new Refusal(unusable());
  const self = { uri: parent.data.uri, cid: parent.data.cid };
  return { root: parent.data.value.reply?.root ?? self, parent: self };
}

const strongRef = z.object({ uri: z.string().max(512), cid: z.string().max(256) });
const recordRead = z.object({
  uri: z.string().max(512),
  cid: z.string().min(1).max(256),
  value: z.object({ reply: z.object({ root: strongRef }).optional() }),
});

function embedOf(context: AdapterContext, mediaIds: readonly string[] | undefined) {
  if (mediaIds === undefined || mediaIds.length === 0) return undefined;
  const images = mediaIds.map((id, position) => {
    const blob = blobRef.safeParse(textToJson(id));
    if (!blob.success) throw new Refusal(refusedInput());
    return { alt: context.media?.items[position]?.altText ?? "", image: blob.data };
  });
  return { $type: "app.bsky.embed.images", images };
}

// A mention is resolved the way a handle is at sign-in. One that does not resolve (no account, no such host, a lookup
// that failed) stays plain text; only an address the egress policy refuses fails the post.
const mentionResolver = (context: AdapterContext) => async (handle: string) => {
  try {
    return await resolveHandle(context, handle);
  } catch (error) {
    if (error instanceof Refusal && error.result.providerCode !== "address_not_allowed") return undefined;
    throw error;
  }
};

async function recordOf(context: AdapterContext, input: CommitInput, access: Access) {
  const facets = await detectFacets(input.text, mentionResolver(context));
  const reply =
    input.replyToExternalId === undefined
      ? undefined
      : await replyRefs(context, access, input.replyToExternalId);
  const embed = embedOf(context, input.mediaIds);
  const lang = languageOf(input.locale);
  return {
    $type: POST_COLLECTION,
    text: input.text,
    createdAt: context.now().toISOString(),
    ...(facets.length > 0 ? { facets } : {}),
    ...(reply === undefined ? {} : { reply }),
    ...(embed === undefined ? {} : { embed }),
    ...(lang === undefined ? {} : { langs: [lang] }),
  };
}

async function commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const access = accessOf(input.account);
  if (access === undefined || input.idempotencyKey === "") return refusedInput();
  if (!withinLimits(input.text)) return refused("text_too_long");
  const rkey = rkeyOf(input.idempotencyKey);
  const record = await recordOf(context, input, access);
  const body = { repo: access.did, collection: POST_COLLECTION, rkey, record };
  const answer = await xrpc(
    context,
    access,
    "com.atproto.repo.createRecord",
    { method: "POST", json: body },
    true,
  );
  if (!answer.ok) return answer.result;
  // A 200 that does not name the record asked for may still have created one: the outcome is unknown, not none.
  const created = recordAnswer.safeParse(answer.json);
  if (!created.success || created.data.uri !== uriOf(access.did, rkey)) return unknown();
  return {
    ok: true,
    effect: "confirmed",
    externalId: created.data.uri,
    permalink: permalinkOf(access.did, rkey),
  };
}

// The key of a post: from its remote id when the ledger has one, else from the operation's marker (a lost answer has no id).
function targetOf(
  post: RemotePost,
  access: Access,
): { readonly rkey: string; readonly uri: string } | undefined {
  if (post.externalId !== undefined) {
    const parsed = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(post.externalId);
    return parsed !== null && parsed[1] === access.did && TID.test(parsed[2] ?? "")
      ? { rkey: parsed[2] ?? "", uri: post.externalId }
      : undefined;
  }
  if (post.idempotencyKey === undefined || post.idempotencyKey === "") return undefined;
  const rkey = rkeyOf(post.idempotencyKey);
  return { rkey, uri: uriOf(access.did, rkey) };
}

const TID = /^[234567abcdefghij][234567a-z]{12}$/;

const isMissing = (reply: Reply & { readonly ok: false }) =>
  reply.status === 404 || (reply.status === 400 && errorName(reply.json) === "RecordNotFound");

async function readRecord(context: AdapterContext, access: Access, rkey: string) {
  const query = { repo: access.did, collection: POST_COLLECTION, rkey };
  return xrpc(context, access, "com.atproto.repo.getRecord", { method: "GET", query }, false);
}

// A read of the key the commit used. A record the PDS says is not there is an absent answer, which core only trusts after
// two reads a gap apart; the PDS answers it 400 `RecordNotFound`.
async function readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const access = accessOf(post.account);
  const target = access === undefined ? undefined : targetOf(post, access);
  if (access === undefined || target === undefined) return refusedInput();
  const answer = await readRecord(context, access, target.rkey);
  if (!answer.ok) return isMissing(answer) ? { ...answer.result, absent: true } : answer.result;
  const found = recordRead.safeParse(answer.json);
  if (!found.success || found.data.uri !== target.uri) return unusable();
  return {
    ok: true,
    effect: "confirmed",
    externalId: target.uri,
    permalink: permalinkOf(access.did, target.rkey),
  };
}

// deleteRecord answers 200 for a record that is not there (VERIFY, the lexicon page says nothing). A 404 on the delete
// alone proves nothing (a stale or proxied answer): one read of the same key decides.
async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const access = accessOf(post.account);
  const target = access === undefined ? undefined : targetOf(post, access);
  if (access === undefined || target === undefined) return refusedInput();
  const body = { repo: access.did, collection: POST_COLLECTION, rkey: target.rkey };
  const answer = await xrpc(
    context,
    access,
    "com.atproto.repo.deleteRecord",
    { method: "POST", json: body },
    true,
  );
  if (answer.ok) return { ok: true, effect: "confirmed" };
  if (!isMissing(answer)) return answer.result;
  const read = await readRecord(context, access, target.rkey);
  if (!read.ok) return isMissing(read) ? { ok: true, ...NO_EFFECT } : unknown();
  return errorResult({ effect: "possible", errorClass: "unknown", providerCode: "still_present" });
}

const imageCap = () => blueskyManifest.limits.imageMaxBytes?.value ?? 0;

function refusedMedia(items: readonly MediaItem[]): boolean {
  const cap = imageCap();
  const count = blueskyManifest.limits.mediaMaxCount?.value ?? 0;
  return items.length > count || items.some((item) => !item.mime.startsWith("image/") || item.size > cap);
}

async function uploadOne(context: AdapterContext, access: Access, media: MediaReader, position: number) {
  if (media.items[position] === undefined) return refusedInput();
  let file: MediaFile;
  try {
    file = await media.read(position);
  } catch (error) {
    if (!(error instanceof MediaReadError)) throw error;
    return refused("media_unavailable");
  }
  // The size the reader stated was checked first; the bytes it actually gave are what goes on the wire.
  if (file.bytes.byteLength > imageCap()) return refusedInput();
  const raw = { bytes: file.bytes, mime: media.items[position].mime };
  // An upload leaves no post behind, so a lost answer is a plain failure: a retry only uploads again.
  const answer = await xrpc(context, access, "com.atproto.repo.uploadBlob", { method: "POST", raw }, false);
  if (!answer.ok) return answer.result;
  const uploaded = uploadAnswer.safeParse(answer.json);
  if (!uploaded.success) return unusable();
  return { ok: true as const, ...NO_EFFECT, upload: { mediaId: JSON.stringify(uploaded.data.blob) } };
}

// One medium per call, the next one after the ids already stored. Every file is checked against the limits before the
// first one is sent.
async function prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const { media } = context;
  const done = input.mediaIds?.length ?? 0;
  if (media === undefined || done >= media.items.length) return { ok: true, ...NO_EFFECT };
  const access = accessOf(input.account);
  if (access === undefined) return refusedInput();
  if (done === 0 && refusedMedia(media.items)) return refusedInput();
  return uploadOne(context, access, media, done);
}

const sessionAnswer = z.object({ did: z.string().max(512) });

// An authenticated read that names the account, so a token the PDS no longer takes shows as revoked. The page for
// com.atproto.server.getSession does not say whether the `transition:generic` scope allows it: VERIFY at the live run.
async function inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult> {
  const access = accessOf(input);
  if (access === undefined) return refusedInput();
  const answer = await xrpc(context, access, "com.atproto.server.getSession", { method: "GET" }, false);
  if (!answer.ok) return answer.result;
  const session = sessionAnswer.safeParse(answer.json);
  if (!session.success || session.data.did !== access.did) return unusable();
  return { ok: true, ...NO_EFFECT, health: "ok" };
}

// The answer's OAuth error name is the code, and the manifest maps only `invalid_grant` to a revoked sign-in. Any other 4xx
// (a proof the server did not like, a bodyless 403, a 409) flags the channel and leaves it connected, like a server that
// keeps asking for a new nonce, a 5xx, a 429 or a cut answer.
function refreshFailure(answer: Extract<Reply, { readonly ok: false }>): ProviderResult {
  const { status, json } = answer;
  const name = errorName(json);
  if (name === "use_dpop_nonce") {
    return errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send", providerCode: name });
  }
  if (status === undefined || status >= 500 || status === 429) return answer.result;
  const code = name === undefined ? {} : { providerCode: name };
  return { ...errorResult({ ...NO_EFFECT, errorClass: "permanent", ...code }), httpStatus: status };
}

async function refresh(context: AdapterContext, input: RefreshInput): Promise<ProviderResult> {
  const { app, dpopKey, issuer } = input;
  if (app === undefined || dpopKey === undefined || issuer === undefined) return refusedInput();
  try {
    const server = await discoverServer(context, issuer);
    const grant = { grant_type: "refresh_token", refresh_token: input.refreshToken.expose() };
    const reply = await tokenGrant(context, { server, app, dpopKey: keyOf(dpopKey), grant });
    if (!reply.ok) return refreshFailure(reply);
    const token = tokenOf(reply);
    return {
      ok: true,
      ...NO_EFFECT,
      credential: {
        accessToken: new SealedSecret(token.access_token),
        ...(token.refresh_token === undefined ? {} : { refreshToken: new SealedSecret(token.refresh_token) }),
        ...(token.expires_in === undefined ? {} : { expiresInSeconds: token.expires_in }),
      },
    };
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    throw error;
  }
}

// A step that cannot go on (a stored key that cannot be used, an address the policy refuses) is the call's result.
const refusing =
  <Args extends unknown[]>(run: (...args: Args) => Promise<ProviderResult>) =>
  async (...args: Args): Promise<ProviderResult> => {
    try {
      return await run(...args);
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      throw error;
    }
  };

export function createBlueskyAdapter(): ProviderAdapter {
  return {
    prepare: refusing(prepare),
    commit: refusing(commit),
    readBack: refusing(readBack),
    delete: refusing(remove),
    refresh,
    inspect: refusing(inspect),
    connect,
  };
}
