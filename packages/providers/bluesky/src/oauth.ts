import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext, AppCredentials } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { call, errorName, Refusal, type Reply, readJson, refused, textToJson, unusable } from "./http.js";

// Built from https://atproto.com/specs/oauth (read 2026-11-27): a confidential client with private_key_jwt (ES256),
// DPoP with server nonces, a pushed authorization request and PKCE S256. DPoP is RFC 9449 and the client assertion is
// RFC 7523. No key or token is ever put in a URL.

const privateJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1).max(64),
  y: z.string().min(1).max(64),
  d: z.string().min(1).max(64),
});
export type PrivateJwk = z.infer<typeof privateJwk>;

export function newKey(): PrivateJwk {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  return privateJwk.parse(jwk);
}

/** A key that is not a P-256 private key is a stored value that cannot be used, never something to send. */
export function keyOf(secret: SealedSecret): PrivateJwk {
  const parsed = privateJwk.safeParse(textToJson(secret.expose()));
  if (!parsed.success) throw new Refusal(refused("invalid_key"));
  return parsed.data;
}

export const publicOf = ({ kty, crv, x, y }: PrivateJwk) => ({ kty, crv, x, y });

// RFC 7638: the thumbprint of the public members, so one key always carries one `kid`.
export function thumbprint(key: PrivateJwk): string {
  const { crv, kty, x, y } = key;
  return createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: PrivateJwk): string {
  const signed = `${encode(header)}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(signed), {
    key: createPrivateKey({ key, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  });
  return `${signed}.${signature.toString("base64url")}`;
}

const urlForProof = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
};

interface ProofInput {
  readonly method: string;
  readonly url: string;
  readonly now: Date;
  readonly nonce?: string;
  readonly accessToken?: string;
}

function dpopProof(key: PrivateJwk, input: ProofInput): string {
  const claims = {
    jti: randomUUID(),
    htm: input.method,
    htu: urlForProof(input.url),
    iat: Math.floor(input.now.getTime() / 1000),
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    ...(input.accessToken === undefined
      ? {}
      : { ath: createHash("sha256").update(input.accessToken).digest("base64url") }),
  };
  return jwt({ typ: "dpop+jwt", alg: "ES256", jwk: publicOf(key) }, claims, key);
}

interface DpopInit {
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

// A server that wants a nonce answers 400 (authorization server) or 401 (resource server) with `DPoP-Nonce` and refuses the
// request before it does anything, so the one retry with that nonce cannot send an effect twice.
async function wantsNonce(response: Response): Promise<string | undefined> {
  const nonce = response.headers.get("dpop-nonce");
  if (nonce === null || (response.status !== 400 && response.status !== 401)) return undefined;
  const header = response.headers.get("www-authenticate") ?? "";
  const named =
    header.includes("use_dpop_nonce") || errorName(await readJson(response.clone())) === "use_dpop_nonce";
  return named ? nonce : undefined;
}

interface DpopCall {
  readonly key: PrivateJwk;
  readonly url: string;
  readonly init: DpopInit;
  readonly accessToken?: string;
}

/** Sends one request bound to the key, retrying once with the nonce the server names. */
export async function dpopFetch(context: AdapterContext, request: DpopCall): Promise<Response> {
  const { key, url, init, accessToken } = request;
  const attempt = (nonce?: string) =>
    context.fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        dpop: dpopProof(key, {
          method: init.method,
          url,
          now: context.now(),
          ...(nonce === undefined ? {} : { nonce }),
          ...(accessToken === undefined ? {} : { accessToken }),
        }),
        ...(accessToken === undefined ? {} : { authorization: `DPoP ${accessToken}` }),
      },
    });
  const first = await attempt();
  const nonce = await wantsNonce(first);
  return nonce === undefined ? first : attempt(nonce);
}

const serverMetadata = z.object({
  issuer: z.string().max(512),
  token_endpoint: z.string().max(2048),
  pushed_authorization_request_endpoint: z.string().max(2048),
  authorization_endpoint: z.string().max(2048),
  code_challenge_methods_supported: z.array(z.string()).max(16),
  token_endpoint_auth_methods_supported: z.array(z.string()).max(16),
  token_endpoint_auth_signing_alg_values_supported: z.array(z.string()).max(16),
  dpop_signing_alg_values_supported: z.array(z.string()).max(16),
});

export interface AuthServer {
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly parEndpoint: string;
  readonly authorizationEndpoint: string;
}

const isHttps = (url: string) => URL.canParse(url) && new URL(url).protocol === "https:";

/** The authorization server's metadata, accepted only if it is the issuer asked for and can do what the profile needs. */
export async function discoverServer(context: AdapterContext, issuer: string): Promise<AuthServer> {
  const reply = await call(context.now, () =>
    context.fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
    }),
  );
  if (!reply.ok) throw new Refusal(reply.result);
  return authServerOf(reply.json, issuer);
}

function authServerOf(json: unknown, issuer: string): AuthServer {
  const parsed = serverMetadata.safeParse(json);
  if (!parsed.success) throw new Refusal(unusable());
  const meta = parsed.data;
  const capable =
    meta.issuer === issuer &&
    meta.code_challenge_methods_supported.includes("S256") &&
    meta.token_endpoint_auth_methods_supported.includes("private_key_jwt") &&
    meta.token_endpoint_auth_signing_alg_values_supported.includes("ES256") &&
    meta.dpop_signing_alg_values_supported.includes("ES256") &&
    [meta.token_endpoint, meta.pushed_authorization_request_endpoint, meta.authorization_endpoint].every(
      isHttps,
    );
  if (!capable) throw new Refusal(refused("auth_server_unsupported"));
  return {
    issuer,
    tokenEndpoint: meta.token_endpoint,
    parEndpoint: meta.pushed_authorization_request_endpoint,
    authorizationEndpoint: meta.authorization_endpoint,
  };
}

export const SCOPE = "atproto transition:generic";

/** The client key the app holds: its public part is published, its `kid` is the key's thumbprint. */
export const appKeyOf = (app: AppCredentials): PrivateJwk => keyOf(app.clientSecret);

function clientAuth(app: AppCredentials, issuer: string, now: Date): Record<string, string> {
  const key = appKeyOf(app);
  const iat = Math.floor(now.getTime() / 1000);
  const claims = { iss: app.clientId, sub: app.clientId, aud: issuer, jti: randomUUID(), iat, exp: iat + 60 };
  return {
    client_id: app.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: jwt({ alg: "ES256", typ: "JWT", kid: thumbprint(key) }, claims, key),
  };
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(fields).toString(),
});

const pushed = z.object({ request_uri: z.string().min(1).max(512) });

interface PushInput {
  readonly server: AuthServer;
  readonly app: AppCredentials;
  readonly dpopKey: PrivateJwk;
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly loginHint: string;
}

/** The pushed authorization request: its answer is the `request_uri` the browser is sent with. */
export async function pushAuthorization(context: AdapterContext, input: PushInput): Promise<string> {
  const { server, app, dpopKey } = input;
  const body = {
    ...clientAuth(app, server.issuer, context.now()),
    response_type: "code",
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    login_hint: input.loginHint,
  };
  const reply = await call(context.now, () =>
    dpopFetch(context, { key: dpopKey, url: server.parEndpoint, init: form(body) }),
  );
  if (!reply.ok) throw new Refusal(reply.result);
  const answer = pushed.safeParse(reply.json);
  if (!answer.success) throw new Refusal(unusable());
  return answer.data.request_uri;
}

const tokenAnswer = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  token_type: z.string().max(16),
  expires_in: z.int().positive().max(31_536_000).optional(),
  scope: z.string().max(512),
  sub: z.string().min(1).max(512),
});
type TokenAnswer = z.infer<typeof tokenAnswer>;

interface GrantInput {
  readonly server: AuthServer;
  readonly app: AppCredentials;
  readonly dpopKey: PrivateJwk;
  readonly grant: Record<string, string>;
}

/** A grant at the token endpoint: the code exchange or a refresh. A failure is the reply, so a caller can class it. */
export async function tokenGrant(context: AdapterContext, input: GrantInput): Promise<Reply> {
  const { server, app, dpopKey } = input;
  const body = { ...clientAuth(app, server.issuer, context.now()), ...input.grant };
  return call(
    context.now,
    () => dpopFetch(context, { key: dpopKey, url: server.tokenEndpoint, init: form(body) }),
    true,
  );
}

/** A token answer that is a DPoP token for the atproto scope and has a DID as its subject. */
export function tokenOf(reply: Extract<Reply, { readonly ok: true }>): TokenAnswer {
  const parsed = tokenAnswer.safeParse(reply.json);
  const usable =
    parsed.success &&
    parsed.data.token_type.toLowerCase() === "dpop" &&
    parsed.data.scope.split(" ").includes("atproto");
  if (!usable) throw new Refusal(refused("token_unusable"));
  return parsed.data;
}
