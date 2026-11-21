import { z } from "zod";
import { checkDpopProof, pkceMatches } from "../simulator/auth.js";
import { type Handler, type SimReply, startSimulator } from "../simulator/server.js";

export interface OAuthFakeOptions {
  /** The clock, so a code, a pushed request and a token expire when a test moves it. */
  readonly now: () => Date;
  /** When set, the token route demands a DPoP proof and a server nonce, and issues `DPoP` tokens. */
  readonly requireDpop?: boolean;
}

// The fake's own lifetimes, not any provider's.
const CODE_TTL_MS = 60_000;
const REQUEST_URI_TTL_MS = 90_000;
const ACCESS_TOKEN_TTL_S = 300;
const DPOP_NONCE = "server-nonce-1";

// What an authorization request carries, pushed (PAR) or sent to /authorize. Only S256 is accepted.
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

// The answer to a refused request: a fixed error code and nothing the caller sent.
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
  /** Armed by a test: the next refresh answer carries no new refresh token. */
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

// Tokens for a grant; a new refresh token is issued (and remembered) unless the caller leaves it out.
function issue(store: Store, withRefreshToken = true): SimReply {
  const refresh = store.next("refresh-token");
  if (withRefreshToken) store.refreshTokens.add(refresh);
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

// A refresh token is single use: a successful refresh swaps it for a new one, unless the answer is armed to omit it, in
// which case the token that was used stays valid.
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

/**
 * The routes of an OAuth 2.1 authorization server for a public client: `GET /authorize` (approves at once), `POST /par`
 * and `POST /token` for the authorization-code and refresh-token grants. A code, a pushed request and a refresh token
 * are single use. `omitNextRefreshToken` arms the next refresh answer to carry no new refresh token.
 */
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

/** Starts the authorization server on a loopback port. */
export function startOAuthFake(options: OAuthFakeOptions) {
  return startSimulator(oauthRoutes(options).routes);
}
