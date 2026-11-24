import { randomBytes } from "node:crypto";
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
// `methods/instance` (GET /api/v2/instance, `configuration.statuses` and `configuration.media_attachments`).

interface Limits {
  readonly maxCharacters: number;
  readonly reservedPerUrl: number;
  readonly maxMedia: number;
  readonly imageSizeLimit: number;
}

export interface SimulatorSettings {
  /** The discovery document: absent (404), without S256, or naming the endpoints of another host. */
  readonly discovery?: "ok" | "missing" | "no_s256" | "foreign_endpoints";
  /** What verify_credentials answers: the account, a 401, an object with no account, or a body that is no JSON. */
  readonly verify?: "ok" | "revoked" | "stub" | "not_json";
  readonly limits?: Partial<Limits>;
}

export interface MastodonSimulatorOptions {
  readonly now: () => Date;
}

export interface MastodonSimulator extends Simulator {
  /** The apps registered, oldest first, with their secrets (a test's canary). */
  readonly apps: readonly { readonly clientId: string; readonly clientSecret: string }[];
  /** The access tokens issued, oldest first. */
  readonly tokens: readonly string[];
  /** Forgets everything held and the requests seen, and sets how the instance answers from now on. */
  reset(settings?: SimulatorSettings): void;
  /** From now on the instance answers 401 `invalid_client` for every app registered so far. */
  revokeApps(): void;
  /** A token that verify_credentials accepts. */
  issueToken(): string;
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

// The instance approves at once: the redirect carries the code and the state back to the redirect URI as sent.
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

// A client the instance does not know (never registered, or forgotten) is refused before the grant is looked at.
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

/** Starts the instance on a loopback port. `reset` clears what it holds and changes how it answers. */
export async function startMastodonSimulator(options: MastodonSimulatorOptions): Promise<MastodonSimulator> {
  const state: State = {
    now: options.now,
    apps: [],
    tokens: [],
    revoked: new Set(),
    codes: new Map(),
    settings: {},
  };
  const simulator = await startSimulator({
    "GET /.well-known/oauth-authorization-server": (request) => discovery(state, request.headers.host),
    "POST /api/v1/apps": registerApp(state),
    "GET /oauth/authorize": authorize(state),
    "POST /oauth/token": token(state),
    "GET /api/v1/accounts/verify_credentials": verifyCredentials(state),
    "GET /api/v2/instance": instance(state),
  });
  return {
    ...simulator,
    /** The apps registered, oldest first, with their secrets (a test's canary). */
    get apps(): readonly App[] {
      return state.apps;
    },
    /** The access tokens issued, oldest first. */
    get tokens(): readonly string[] {
      return state.tokens;
    },
    /** Forgets everything held and the requests seen, and sets how the instance answers from now on. */
    reset(settings: SimulatorSettings = {}): void {
      Object.assign(state, { apps: [], tokens: [], revoked: new Set(), codes: new Map(), settings });
      (simulator.requests as unknown[]).length = 0;
    },
    /** From now on the instance answers 401 `invalid_client` for every app registered so far. */
    revokeApps(): void {
      for (const app of state.apps) state.revoked.add(app.clientId);
    },
    /** A token that verify_credentials accepts. */
    issueToken: () => issue(state),
  };
}
