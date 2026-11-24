import { randomBytes } from "node:crypto";
import type {
  MatrixFault,
  MatrixOperation,
  StoredPost,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { pkceMatches } from "@shoutory/testkit/simulator/auth";
import {
  type Handler,
  type SimReply,
  type Simulator,
  startSimulator,
} from "@shoutory/testkit/simulator/server";

// A Mastodon instance as docs.joinmastodon.org documents it, every route with the page it is built from (all read
// 2026-11-24): `methods/apps` (POST /api/v1/apps answers client_id and client_secret, 422 on bad input), `spec/oauth`
// (the discovery document at /.well-known/oauth-authorization-server with `code_challenge_methods_supported`, the
// authorization route, PKCE S256 from 4.3.0), `methods/oauth` (POST /oauth/token answers 401 `invalid_client` for a client
// it does not know), `methods/accounts` (GET /api/v1/accounts/verify_credentials answers 401 for a bad token) and
// `methods/instance` (GET /api/v2/instance, `configuration.statuses` and `configuration.media_attachments`) and
// `methods/statuses` (POST /api/v1/statuses answers the Status, takes `Idempotency-Key` and keeps it for up to 1 hour,
// 401 `{"error":"The access token is invalid"}`, 422 `{"error":"Validation failed: ..."}`; GET /api/v1/statuses/:id
// answers the Status, 404 `{"error":"Record not found"}`; DELETE /api/v1/statuses/:id answers the Status with its `text`,
// 404 `{"error":"Record not found"}`).

interface Limits {
  readonly maxCharacters: number;
  readonly reservedPerUrl: number;
  readonly maxMedia: number;
  readonly imageSizeLimit: number;
}

export interface SimulatorSettings {
  readonly discovery?: "ok" | "missing" | "no_s256" | "foreign_endpoints";
  readonly verify?: "ok" | "revoked" | "stub" | "not_json";
  readonly limits?: Partial<Limits>;
}

export interface MastodonSimulatorOptions {
  readonly now: () => Date;
}

export interface MastodonSimulator extends Simulator {
  readonly apps: readonly { readonly clientId: string; readonly clientSecret: string }[];
  readonly tokens: readonly string[];
  reset(settings?: SimulatorSettings): void;
  revokeApps(): void;
  issueToken(): string;
  arm(operation: MatrixOperation, fault: MatrixFault): void;
  stored(): readonly StoredPost[];
}

const DEFAULT_LIMITS: Limits = {
  maxCharacters: 500,
  reservedPerUrl: 23,
  maxMedia: 4,
  imageSizeLimit: 10_485_760,
};
const ACCOUNT_ID = "109000000000000001";
const CODE_TTL_MS = 60_000;

interface App {
  readonly clientId: string;
  readonly clientSecret: string;
}
interface Grant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

const formOf = (body: Buffer) => Object.fromEntries(new URLSearchParams(body.toString("utf8")));
const fail = (status: number, error: string, description?: string): SimReply => ({
  status,
  body: description === undefined ? { error } : { error, error_description: description },
});

interface State {
  readonly now: () => Date;
  apps: App[];
  tokens: string[];
  revoked: Set<string>;
  codes: Map<string, Grant>;
  settings: SimulatorSettings;
  statuses: Map<string, StoredPost>;
  keys: Map<string, { id: string; at: number }>;
}

function discovery(state: State, host: string | undefined): SimReply {
  const mode = state.settings.discovery ?? "ok";
  if (mode === "missing") return fail(404, "not_found");
  const base = mode === "foreign_endpoints" ? "https://elsewhere.example.test" : `http://${host}`;
  return {
    status: 200,
    body: {
      issuer: `http://${host}`,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      code_challenge_methods_supported: mode === "no_s256" ? ["plain"] : ["S256"],
    },
  };
}

const registerApp =
  (state: State): Handler =>
  (request) => {
    const fields = formOf(request.body);
    if (!fields.client_name || !fields.redirect_uris) {
      return fail(422, "Validation failed: Name can't be blank, Redirect URI can't be blank");
    }
    const app = {
      clientId: `client-${state.apps.length + 1}-${randomBytes(6).toString("hex")}`,
      clientSecret: randomBytes(24).toString("base64url"),
    };
    state.apps.push(app);
    return {
      status: 200,
      body: {
        id: String(state.apps.length),
        name: fields.client_name,
        website: null,
        scopes: (fields.scopes ?? "read").split(" "),
        redirect_uris: [fields.redirect_uris],
        redirect_uri: fields.redirect_uris,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        client_secret_expires_at: 0,
      },
    };
  };

const authorize =
  (state: State): Handler =>
  (request) => {
    const query = Object.fromEntries(request.query);
    const valid =
      query.response_type === "code" &&
      query.code_challenge_method === "S256" &&
      query.client_id !== undefined &&
      query.redirect_uri !== undefined &&
      URL.canParse(query.redirect_uri);
    if (!valid || query.client_id === undefined || query.redirect_uri === undefined) {
      return fail(400, "invalid_request");
    }
    const code = `code-${randomBytes(8).toString("hex")}`;
    state.codes.set(code, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      challenge: query.code_challenge ?? "",
      expiresAt: state.now().getTime() + CODE_TTL_MS,
    });
    const location = new URL(query.redirect_uri);
    location.searchParams.set("code", code);
    if (query.state !== undefined) location.searchParams.set("state", query.state);
    return { status: 302, headers: { location: location.href } };
  };

const INVALID_CLIENT =
  "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.";

const token =
  (state: State): Handler =>
  (request) => {
    const fields = formOf(request.body);
    const app = state.apps.find((candidate) => candidate.clientId === fields.client_id);
    if (!app || state.revoked.has(app.clientId) || app.clientSecret !== fields.client_secret) {
      return fail(401, "invalid_client", INVALID_CLIENT);
    }
    const grant = state.codes.get(fields.code ?? "");
    state.codes.delete(fields.code ?? "");
    const usable =
      grant !== undefined &&
      grant.expiresAt > state.now().getTime() &&
      grant.clientId === app.clientId &&
      grant.redirectUri === fields.redirect_uri &&
      pkceMatches(fields.code_verifier ?? "", grant.challenge);
    if (!usable) return fail(400, "invalid_grant");
    const access = issue(state);
    return {
      status: 200,
      body: {
        access_token: access,
        token_type: "Bearer",
        scope: fields.scope ?? "read",
        created_at: Math.floor(state.now().getTime() / 1000),
      },
    };
  };

function issue(state: State): string {
  const access = `token-${randomBytes(24).toString("base64url")}`;
  state.tokens.push(access);
  return access;
}

const accountBody = {
  id: ACCOUNT_ID,
  username: "sim",
  acct: "sim",
  display_name: "Simulated Account",
  avatar: "https://files.example.test/avatar.png",
};

const verifyCredentials =
  (state: State): Handler =>
  (request) => {
    const mode = state.settings.verify ?? "ok";
    if (mode === "revoked") return fail(401, "The access token is invalid");
    if (mode === "stub") return { status: 200, body: {} };
    if (mode === "not_json")
      return { status: 200, headers: { "content-type": "text/html" }, body: "<html>stub</html>" };
    const held = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    return state.tokens.includes(held)
      ? { status: 200, body: accountBody }
      : fail(401, "The access token is invalid");
  };

const instance =
  (state: State): Handler =>
  (request) => {
    const limits = { ...DEFAULT_LIMITS, ...state.settings.limits };
    return {
      status: 200,
      body: {
        domain: request.headers.host,
        version: "4.3.0",
        configuration: {
          statuses: {
            max_characters: limits.maxCharacters,
            max_media_attachments: limits.maxMedia,
            characters_reserved_per_url: limits.reservedPerUrl,
          },
          media_attachments: { image_size_limit: limits.imageSizeLimit },
        },
      },
    };
  };

const INVALID_TOKEN = "The access token is invalid";
const NOT_FOUND = "Record not found";
// An Idempotency-Key is kept for up to one hour (methods/statuses, accessed 2026-11-24).
const KEY_WINDOW_MS = 3_600_000;

function refusedToken(
  state: State,
  request: { headers: Readonly<Record<string, string>> },
): SimReply | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return fail(401, INVALID_TOKEN);
  return state.tokens.includes(header.replace(/^Bearer /, "")) ? undefined : fail(401, INVALID_TOKEN);
}

function statusBody(post: StoredPost, host: string | undefined) {
  return {
    id: post.externalId,
    created_at: "2026-11-24T00:00:00.000Z",
    in_reply_to_id: post.replyToExternalId ?? null,
    visibility: "public",
    content: `<p>${post.text}</p>`,
    text: post.text,
    url: `http://${host}/@sim/${post.externalId}`,
  };
}

const jsonOrForm = (body: Buffer): Record<string, unknown> => {
  const text = body.toString("utf8");
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  }
  return formOf(body);
};

// VERIFY: the statuses page says only that keys are "stored for up to 1 hour" (docs.joinmastodon.org/methods/statuses,
// accessed 2026-11-24) and gives no answer for a repeated key, so answering it with 200 and the same status is this
// simulator's assumption, never a fact a resend may rest on. Private visibility is not modelled either, so
// `read:statuses` is unproven until the live run.
function keptFor(state: State, key: string | undefined): StoredPost | undefined {
  const kept = key === undefined ? undefined : state.keys.get(key);
  if (!kept || state.now().getTime() - kept.at >= KEY_WINDOW_MS) return undefined;
  return state.statuses.get(kept.id);
}

const createStatus =
  (state: State): Handler =>
  (request, { effect }) => {
    const refused = refusedToken(state, request);
    if (refused) return refused;
    const fields = jsonOrForm(request.body);
    const text = typeof fields.status === "string" ? fields.status : "";
    if (text === "") return fail(422, "Validation failed: Text can't be blank");
    const key = request.headers["idempotency-key"];
    const known = keptFor(state, key);
    if (known) return { status: 200, body: statusBody(known, request.headers.host) };
    const id = `1090000000000${String(state.statuses.size + 1).padStart(5, "0")}${randomBytes(2).toString("hex")}`;
    const reply =
      typeof fields.in_reply_to_id === "string" ? { replyToExternalId: fields.in_reply_to_id } : {};
    const post = { externalId: id, text, ...reply };
    state.statuses.set(id, post);
    if (key !== undefined) state.keys.set(key, { id, at: state.now().getTime() });
    effect();
    return { status: 200, body: statusBody(post, request.headers.host) };
  };

// A status is public here, so a read needs no token; a token that is sent and is not the instance's is still refused.
const readStatus =
  (state: State): Handler =>
  (request) => {
    if (request.headers.authorization !== undefined) {
      const refused = refusedToken(state, request);
      if (refused) return refused;
    }
    const post = state.statuses.get(request.params.id ?? "");
    return post ? { status: 200, body: statusBody(post, request.headers.host) } : fail(404, NOT_FOUND);
  };

const deleteStatus =
  (state: State): Handler =>
  (request, { effect }) => {
    const refused = refusedToken(state, request);
    if (refused) return refused;
    const post = state.statuses.get(request.params.id ?? "");
    if (!post) return fail(404, NOT_FOUND);
    state.statuses.delete(post.externalId);
    effect();
    return { status: 200, body: statusBody(post, request.headers.host) };
  };

const ROUTES: Readonly<Record<MatrixOperation, string>> = {
  commit: "POST /api/v1/statuses",
  readBack: "GET /api/v1/statuses/:id",
  delete: "DELETE /api/v1/statuses/:id",
  edit: "PUT /api/v1/statuses/:id",
};

function answerTo(fault: MatrixFault) {
  if (fault.kind !== "respond") return fault;
  const documented: Readonly<Record<number, string>> = {
    401: INVALID_TOKEN,
    404: NOT_FOUND,
    422: "Validation failed: Text can't be blank",
  };
  return {
    kind: "respond" as const,
    status: fault.status,
    body: {
      error: fault.providerCode ?? documented[fault.status] ?? "Server error",
      ...(fault.echoId === undefined ? {} : { id: fault.echoId }),
    },
    // `Retry-After` is a generic HTTP header the matrix plays, not a Mastodon fact: the rate-limits page documents only the
    // X-RateLimit-* headers (accessed 2026-11-24), which a test arms directly.
    ...(fault.retryAfter === undefined ? {} : { headers: { "retry-after": fault.retryAfter } }),
    ...(fault.afterEffect === undefined ? {} : { afterEffect: fault.afterEffect }),
  };
}

export async function startMastodonSimulator(options: MastodonSimulatorOptions): Promise<MastodonSimulator> {
  const state: State = {
    now: options.now,
    apps: [],
    tokens: [],
    revoked: new Set(),
    codes: new Map(),
    settings: {},
    statuses: new Map(),
    keys: new Map(),
  };
  const simulator = await startSimulator({
    "GET /.well-known/oauth-authorization-server": (request) => discovery(state, request.headers.host),
    "POST /api/v1/apps": registerApp(state),
    "GET /oauth/authorize": authorize(state),
    "POST /oauth/token": token(state),
    "GET /api/v1/accounts/verify_credentials": verifyCredentials(state),
    "GET /api/v2/instance": instance(state),
    [ROUTES.commit]: createStatus(state),
    [ROUTES.readBack]: readStatus(state),
    [ROUTES.delete]: deleteStatus(state),
  });
  return {
    ...simulator,
    get apps(): readonly App[] {
      return state.apps;
    },
    get tokens(): readonly string[] {
      return state.tokens;
    },
    reset(settings: SimulatorSettings = {}): void {
      Object.assign(state, {
        apps: [],
        tokens: [],
        revoked: new Set(),
        codes: new Map(),
        settings,
        statuses: new Map(),
        keys: new Map(),
      });
      (simulator.requests as unknown[]).length = 0;
    },
    revokeApps(): void {
      for (const app of state.apps) state.revoked.add(app.clientId);
    },
    issueToken: () => issue(state),
    arm(operation, fault): void {
      // The matrix plays "the post is not there" as a 404 on a delete: here that post is really gone, so the read that
      // follows a 404 on a delete finds it gone too (a test that wants a 404 over a live post arms `faults` directly).
      if (operation === "delete" && fault.kind === "respond" && fault.status === 404) state.statuses.clear();
      simulator.faults.failNext(ROUTES[operation], answerTo(fault));
    },
    stored: () => [...state.statuses.values()],
  };
}
