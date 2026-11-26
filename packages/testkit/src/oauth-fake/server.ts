import { z } from "zod";
import { checkDpopProof, pkceMatches, rememberBounded } from "../simulator/auth.js";
import { type Handler, type SimReply, startSimulator } from "../simulator/server.js";

export interface OAuthFakeOptions {
  readonly now: () => Date;
  readonly requireDpop?: boolean;
}

const CODE_TTL_MS = 60_000;
const REQUEST_URI_TTL_MS = 90_000;
const ACCESS_TOKEN_TTL_S = 300;
const DPOP_NONCE = "server-nonce-1";

const authorizationParams = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(256),
  redirect_uri: z.url(),
  state: z.string().min(1).max(512),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.literal("S256"),
});
type AuthorizationParams = z.infer<typeof authorizationParams>;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

const oauthError = (status: number, error: string, headers: Record<string, string> = {}): SimReply => ({
  status,
  headers: { ...NO_STORE, ...headers },
  body: { error },
});

const formOf = (body: Buffer) => Object.fromEntries(new URLSearchParams(body.toString("utf8")));

interface Grant {
  readonly params: AuthorizationParams;
  readonly expiresAt: number;
}

interface Store {
  readonly now: () => Date;
  readonly codes: Map<string, Grant>;
  readonly pushed: Map<string, Grant>;
  readonly refreshTokens: Set<string>;
  readonly requireDpop: boolean;
  readonly seenProofs: Set<string>;
  omitNextRefreshToken: boolean;
  next(kind: string): string;
}

function createStore(options: OAuthFakeOptions): Store {
  let counter = 0;
  return {
    now: options.now,
    requireDpop: options.requireDpop === true,
    seenProofs: new Set(),
    codes: new Map(),
    pushed: new Map(),
    refreshTokens: new Set(),
    omitNextRefreshToken: false,
    next: (kind) => `${kind}-${++counter}`,
  };
}

function approve(store: Store, params: AuthorizationParams, host: string | undefined): SimReply {
  const code = store.next("code");
  store.codes.set(code, { params, expiresAt: store.now().getTime() + CODE_TTL_MS });
  const location = new URL(params.redirect_uri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", params.state);
  location.searchParams.set("iss", `http://${host}`);
  return { status: 302, headers: { ...NO_STORE, location: location.href } };
}

const authorize =
  (store: Store): Handler =>
  (request) => {
    const query = Object.fromEntries(request.query);
    const host = request.headers.host;
    if (query.request_uri === undefined) {
      const parsed = authorizationParams.safeParse(query);
      return parsed.success ? approve(store, parsed.data, host) : oauthError(400, "invalid_request");
    }
    // A pushed request is spent by the first use, right or wrong.
    const stored = store.pushed.get(query.request_uri);
    store.pushed.delete(query.request_uri);
    const usable =
      stored && stored.expiresAt > store.now().getTime() && stored.params.client_id === query.client_id;
    return usable ? approve(store, stored.params, host) : oauthError(400, "invalid_request_uri");
  };

const push =
  (store: Store): Handler =>
  (request) => {
    const fields = formOf(request.body);
    // RFC 9126 section 2.1: a pushed request never carries a request_uri itself.
    const parsed = authorizationParams.safeParse(fields);
    if (fields.request_uri !== undefined || !parsed.success) return oauthError(400, "invalid_request");
    const requestUri = `urn:ietf:params:oauth:request_uri:${store.next("par")}`;
    const expiresAt = store.now().getTime() + REQUEST_URI_TTL_MS;
    store.pushed.set(requestUri, { params: parsed.data, expiresAt });
    return {
      status: 201,
      headers: NO_STORE,
      body: { request_uri: requestUri, expires_in: REQUEST_URI_TTL_MS / 1000 },
    };
  };

function issue(store: Store, withRefreshToken = true): SimReply {
  const refresh = store.next("refresh-token");
  if (withRefreshToken) rememberBounded(store.refreshTokens, refresh);
  return {
    status: 200,
    headers: store.requireDpop ? { ...NO_STORE, "dpop-nonce": DPOP_NONCE } : NO_STORE,
    body: {
      access_token: store.next("access-token"),
      token_type: store.requireDpop ? "DPoP" : "Bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      ...(withRefreshToken ? { refresh_token: refresh } : {}),
    },
  };
}

// The code is spent by the first attempt, right or wrong.
function exchangeCode(store: Store, fields: Record<string, string>): SimReply {
  const grant = store.codes.get(fields.code ?? "");
  store.codes.delete(fields.code ?? "");
  if (!grant || grant.expiresAt <= store.now().getTime()) return oauthError(400, "invalid_grant");
  const { params } = grant;
  const matches =
    fields.client_id === params.client_id &&
    fields.redirect_uri === params.redirect_uri &&
    pkceMatches(fields.code_verifier ?? "", params.code_challenge);
  return matches ? issue(store) : oauthError(400, "invalid_grant");
}

// When the answer is armed to omit the new refresh token, the token that was used stays valid.
function exchangeRefresh(store: Store, fields: Record<string, string>): SimReply {
  const held = fields.refresh_token ?? "";
  if (!store.refreshTokens.has(held)) return oauthError(400, "invalid_grant");
  if (store.omitNextRefreshToken) {
    store.omitNextRefreshToken = false;
    return issue(store, false);
  }
  store.refreshTokens.delete(held);
  return issue(store);
}

// RFC 9449 section 8: a proof is checked before the grant, so a retry with the nonce can reuse the same code.
function refusedProof(store: Store, request: Parameters<Handler>[0]): SimReply | undefined {
  if (!store.requireDpop) return undefined;
  const proof = request.headers.dpop;
  if (proof === undefined) return oauthError(400, "invalid_dpop_proof");
  const verdict = checkDpopProof(proof, {
    method: request.method,
    url: `http://${request.headers.host}${request.path}`,
    now: store.now(),
    nonce: DPOP_NONCE,
    seen: store.seenProofs,
  });
  if (verdict === "use_dpop_nonce") return oauthError(400, verdict, { "dpop-nonce": DPOP_NONCE });
  return verdict === "ok" ? undefined : oauthError(400, verdict);
}

const token =
  (store: Store): Handler =>
  (request) => {
    const refused = refusedProof(store, request);
    if (refused) return refused;
    const fields = formOf(request.body);
    if (fields.grant_type === "authorization_code") return exchangeCode(store, fields);
    if (fields.grant_type === "refresh_token") return exchangeRefresh(store, fields);
    return oauthError(400, "unsupported_grant_type");
  };

export function oauthRoutes(options: OAuthFakeOptions) {
  const store = createStore(options);
  return {
    routes: {
      "GET /authorize": authorize(store),
      "POST /par": push(store),
      "POST /token": token(store),
    } satisfies Record<string, Handler>,
    omitNextRefreshToken: () => {
      store.omitNextRefreshToken = true;
    },
  };
}

export function startOAuthFake(options: OAuthFakeOptions) {
  return startSimulator(oauthRoutes(options).routes);
}
