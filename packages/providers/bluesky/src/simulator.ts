import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  MatrixFault,
  MatrixOperation,
  StoredPost,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { checkDpopProof, pkceMatches } from "@shoutory/testkit/simulator/auth";
import {
  type Handler,
  type SimReply,
  type Simulator,
  startSimulator,
} from "@shoutory/testkit/simulator/server";

// One Bluesky account (its handle, DID document, PDS and authorization server) as the atproto pages document them, each
// route with its page (all read 2026-11-27): atproto.com/specs/oauth (protected-resource and authorization-server
// metadata, PAR, DPoP nonces answered 400 by the authorization server and 401 with WWW-Authenticate by the PDS, the token
// answer with `sub` and `scope`), atproto.com/specs/handle (the HTTPS document), atproto.com/specs/did, the XRPC
// lexicons com.atproto.repo.createRecord, getRecord, deleteRecord and uploadBlob, and app.bsky.feed.post (3000 bytes, 300
// graphemes). What the pages leave open is marked VERIFY and played both ways: a createRecord on a key that already holds
// a record (`duplicateRkey`), and a deleteRecord of a key that holds none (answered 200). A real getRecord of a missing
// record answers 400 `RecordNotFound`.

export const WORLD = {
  did: "did:plc:alicealicealicealicealic",
  handle: "alice.example",
  didWeb: "did:web:bob.example",
  pdsHost: "pds.example",
  issuer: "https://auth.example",
} as const;

export interface SimulatorSettings {
  /** The `sub` the token endpoint answers with. */
  readonly sub?: string;
  readonly scope?: string;
  /** False: the DID document does not list the handle back. */
  readonly claimsHandle?: boolean;
  /** False: the handle has no `/.well-known/atproto-did` document. */
  readonly wellKnown?: boolean;
  /** The authorization server the PDS names in its protected-resource metadata. */
  readonly resourceIssuer?: string;
  /** How many requests each server refuses with a new nonce before it takes a proof; 1 by default. */
  readonly nonceChallenges?: number;
  /** False: a proof without the server's nonce is accepted. */
  readonly nonces?: boolean;
  /** The refresh grant answers this status with an OAuth error body. */
  readonly refreshStatus?: number;
  /** The OAuth error name of that answer (`invalid_grant` by default); null leaves the body empty. */
  readonly refreshError?: string | null;
  /** What createRecord does on a key that holds a record already. */
  readonly duplicateRkey?: "overwrite" | "error";
  /** What the handle's HTTPS document holds instead of the DID. */
  readonly handleDid?: string;
  /** The `resource` the PDS's protected-resource document names. */
  readonly resource?: string;
  /** The `issuer` the authorization server's metadata states about itself. */
  readonly metadataIssuer?: string;
  /** `http`: the token endpoint of the metadata is not an https address. */
  readonly endpoints?: "http";
  /** The key set the client serves: when given, a client assertion must verify against it. */
  readonly clientJwks?: { readonly keys: readonly Record<string, unknown>[] };
  /** `no_s256`: the authorization server does not list the S256 challenge method. */
  readonly authServer?: "no_s256";
  /** An error body repeats the request it answers, as a careless server might. */
  readonly echo?: boolean;
}

export interface BlueskySimulatorOptions extends SimulatorSettings {
  readonly now: () => Date;
}

export interface BlueskySimulator extends Simulator {
  arm(operation: MatrixOperation | "upload", fault: MatrixFault): void;
  stored(): readonly StoredPost[];
  /** How many createRecord requests reached the handler (a nonce refusal is not one). */
  created(): number;
  records(): ReadonlyMap<string, StoredRecord>;
}

export interface StoredRecord {
  readonly uri: string;
  readonly cid: string;
  readonly value: Record<string, unknown>;
}

const POST = "app.bsky.feed.post";
const TID = /^[234567abcdefghij][234567a-z]{12}$/;
const MAX_POST_BYTES = 3000;
const MAX_POST_GRAPHEMES = 300;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2_000_000;
const ACCESS_TOKEN = "bluesky-access-token-canary-1";
const REFRESH_TOKEN = "bluesky-refresh-token-canary-1";

const ROUTES: Readonly<Record<MatrixOperation | "upload", string>> = {
  upload: "POST /xrpc/com.atproto.repo.uploadBlob",
  commit: "POST /xrpc/com.atproto.repo.createRecord",
  readBack: "GET /xrpc/com.atproto.repo.getRecord",
  delete: "POST /xrpc/com.atproto.repo.deleteRecord",
  edit: "POST /xrpc/com.atproto.repo.putRecord",
};

interface Nonce {
  challenges: number;
  counter: number;
  value: string;
}

interface State {
  readonly now: () => Date;
  readonly settings: SimulatorSettings;
  readonly nonces: Record<"auth" | "pds", Nonce>;
  readonly proofs: Set<string>;
  readonly records: Map<string, StoredRecord>;
  readonly blobs: Map<string, number>;
  /** The pushed requests, newest last: the code grant is checked against the newest. */
  readonly pushed: { readonly challenge: string; readonly redirectUri: string }[];
  created: number;
  counter: number;
}

type Request = Parameters<Handler>[0];
type Context = Parameters<Handler>[1];

const fresh = (settings: SimulatorSettings, role: string): Nonce => ({
  challenges: settings.nonces === false ? 0 : (settings.nonceChallenges ?? 1),
  counter: 0,
  value: `${role}-nonce-0`,
});

const fail = (status: number, error: string, headers: Record<string, string> = {}): SimReply => ({
  status,
  headers,
  body: { error },
});

const failing = (state: State, request: Request, status: number, error: string): SimReply =>
  state.settings.echo === true
    ? {
        status,
        body: {
          error,
          request: { path: request.path, headers: request.headers, body: request.body.toString("utf8") },
        },
      }
    : fail(status, error);

function challenge(role: "auth" | "pds", nonce: Nonce): SimReply {
  nonce.value = `${role}-nonce-${++nonce.counter}`;
  const headers = { "dpop-nonce": nonce.value };
  return role === "pds"
    ? fail(401, "use_dpop_nonce", { ...headers, "www-authenticate": 'DPoP error="use_dpop_nonce"' })
    : fail(400, "use_dpop_nonce", headers);
}

// RFC 9449: a proof is checked against the method and URL of the request; a server asking for a nonce refuses before it
// does anything.
function guard(state: State, role: "auth" | "pds", request: Request): SimReply | undefined {
  const nonce = state.nonces[role];
  const proof = request.headers.dpop;
  if (proof === undefined) return fail(role === "pds" ? 401 : 400, "invalid_dpop_proof");
  if (nonce.challenges > 0) {
    nonce.challenges -= 1;
    return challenge(role, nonce);
  }
  const base = role === "auth" ? WORLD.issuer : `https://${WORLD.pdsHost}`;
  const verdict = checkDpopProof(proof, {
    method: request.method,
    url: `${base}${request.path}`,
    now: state.now(),
    nonce: nonce.value,
    seen: state.proofs,
  });
  if (verdict === "ok" || (verdict === "use_dpop_nonce" && state.settings.nonces === false)) return undefined;
  return verdict === "use_dpop_nonce" ? challenge(role, nonce) : fail(role === "pds" ? 401 : 400, verdict);
}

const form = (request: Request) => Object.fromEntries(new URLSearchParams(request.body.toString("utf8")));

const claimsOf = (jwt: string | undefined) => claimsOfPart(jwt?.split(".")[1]);

function claimsOfPart(part: string | undefined): Record<string, unknown> | undefined {
  if (part === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// RFC 7523: the assertion names the client as issuer and subject and the authorization server as audience, and when the
// client's key set is known (the one it serves) the signature must verify against the key its `kid` names.
function signatureHolds(assertion: string | undefined, jwks: SimulatorSettings["clientJwks"]): boolean {
  if (jwks === undefined) return true;
  const [head = "", body = "", signature = ""] = assertion?.split(".") ?? [];
  const kid = claimsOfPart(head)?.kid;
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (jwk === undefined) return false;
  const key = createPublicKey({ key: jwk, format: "jwk" });
  return verify(
    "sha256",
    Buffer.from(`${head}.${body}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

function clientRefused(state: State, fields: Record<string, string>): SimReply | undefined {
  const claims = claimsOf(fields.client_assertion);
  const sound =
    fields.client_assertion_type === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" &&
    claims?.iss === fields.client_id &&
    claims?.sub === fields.client_id &&
    claims?.aud === WORLD.issuer &&
    typeof claims?.jti === "string" &&
    signatureHolds(fields.client_assertion, state.settings.clientJwks);
  return sound ? undefined : fail(401, "invalid_client");
}

// PKCE (RFC 7636) and the redirect address (RFC 6749 section 4.1.3) of the code grant are the ones the pushed request named.
function codeRefused(state: State, fields: Record<string, string>): SimReply | undefined {
  const pushed = state.pushed.at(-1);
  if (pushed === undefined || fields.grant_type !== "authorization_code") return undefined;
  const holds =
    pkceMatches(fields.code_verifier ?? "", pushed.challenge) && fields.redirect_uri === pushed.redirectUri;
  return holds ? undefined : fail(400, "invalid_grant");
}

const document = (state: State): Record<string, Handler> => ({
  "GET /.well-known/atproto-did": () =>
    state.settings.wellKnown === false
      ? { status: 404, body: "" }
      : {
          status: 200,
          headers: { "content-type": "text/plain" },
          body: state.settings.handleDid ?? WORLD.did,
        },
  "GET /:did": (request) => {
    if (request.params.did !== WORLD.did) return fail(404, "NotFound");
    const alsoKnownAs = state.settings.claimsHandle === false ? [] : [`at://${WORLD.handle}`];
    return { status: 200, body: didDocument(WORLD.did, alsoKnownAs) };
  },
  "GET /.well-known/did.json": () => ({ status: 200, body: didDocument(WORLD.didWeb, []) }),
  "GET /.well-known/oauth-protected-resource": () => ({
    status: 200,
    body: {
      resource: state.settings.resource ?? `https://${WORLD.pdsHost}`,
      authorization_servers: [state.settings.resourceIssuer ?? WORLD.issuer],
    },
  }),
  "GET /.well-known/oauth-authorization-server": () => ({
    status: 200,
    body: {
      issuer: state.settings.metadataIssuer ?? WORLD.issuer,
      token_endpoint: `${state.settings.endpoints === "http" ? "http://auth.example" : WORLD.issuer}/oauth/token`,
      pushed_authorization_request_endpoint: `${WORLD.issuer}/oauth/par`,
      authorization_endpoint: `${WORLD.issuer}/oauth/authorize`,
      require_pushed_authorization_requests: true,
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: state.settings.authServer === "no_s256" ? [] : ["S256"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256"],
      dpop_signing_alg_values_supported: ["ES256"],
      scopes_supported: ["atproto", "transition:generic"],
      client_id_metadata_document_supported: true,
    },
  }),
});

const didDocument = (id: string, alsoKnownAs: string[]) => ({
  id,
  alsoKnownAs,
  service: [
    {
      id: "#atproto_pds",
      type: "AtprotoPersonalDataServer",
      serviceEndpoint: `https://${WORLD.pdsHost}`,
    },
  ],
});

const authorizationServer = (state: State): Record<string, Handler> => ({
  "POST /oauth/par": (request) => {
    const fields = form(request);
    const refused = guard(state, "auth", request) ?? clientRefused(state, fields);
    if (refused) return refused;
    const valid =
      fields.response_type === "code" &&
      fields.code_challenge_method === "S256" &&
      Boolean(fields.code_challenge) &&
      fields.scope?.split(" ").includes("atproto") === true;
    if (!valid) return fail(400, "invalid_request");
    state.pushed.push({ challenge: fields.code_challenge ?? "", redirectUri: fields.redirect_uri ?? "" });
    return {
      status: 201,
      body: { request_uri: `urn:ietf:params:oauth:request_uri:req-${++state.counter}`, expires_in: 90 },
    };
  },
  "POST /oauth/token": (request) => {
    const fields = form(request);
    const refused =
      guard(state, "auth", request) ?? clientRefused(state, fields) ?? codeRefused(state, fields);
    if (refused) return refused;
    if (fields.grant_type === "refresh_token" && state.settings.refreshStatus !== undefined) {
      const { refreshStatus, refreshError } = state.settings;
      if (refreshError === null) return { status: refreshStatus };
      return failing(state, request, refreshStatus, refreshError ?? "invalid_grant");
    }
    if (fields.grant_type !== "refresh_token" && fields.grant_type !== "authorization_code") {
      return fail(400, "unsupported_grant_type");
    }
    return {
      status: 200,
      headers: { "dpop-nonce": state.nonces.auth.value, "cache-control": "no-store" },
      body: {
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        token_type: "DPoP",
        expires_in: 1800,
        scope: state.settings.scope ?? "atproto transition:generic",
        sub: state.settings.sub ?? WORLD.did,
      },
    };
  },
});

const cidOf = (text: string) => `bafyrei${createHash("sha256").update(text).digest("hex").slice(0, 40)}`;
const uriOf = (rkey: string) => `at://${WORLD.did}/${POST}/${rkey}`;

const jsonBody = (request: Request): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(request.body.toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const graphemes = (text: string) =>
  [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].length;

// app.bsky.feed.post: 3000 bytes and 300 graphemes of text, at most four images each with a blob that was uploaded.
function invalidPost(state: State, record: Record<string, unknown>): string | undefined {
  const text = record.text;
  if (typeof text !== "string" || typeof record.createdAt !== "string")
    return "the record has no text or createdAt";
  if (Buffer.byteLength(text) > MAX_POST_BYTES || graphemes(text) > MAX_POST_GRAPHEMES)
    return "the text is too long";
  const embed = record.embed as { images?: { image?: { ref?: { $link?: string } } }[] } | undefined;
  const images = embed?.images ?? [];
  if (images.length > MAX_IMAGES) return "too many images";
  const unknownBlob = images.some((one) => !state.blobs.has(one.image?.ref?.$link ?? ""));
  return unknownBlob ? "an image blob was never uploaded" : undefined;
}

function createRecord(state: State, request: Request, context: Context): SimReply {
  const refused = guard(state, "pds", request);
  if (refused) return refused;
  state.created += 1;
  const body = jsonBody(request);
  const { rkey, record, repo, collection } = body ?? {};
  const valid =
    repo === WORLD.did &&
    collection === POST &&
    typeof rkey === "string" &&
    TID.test(rkey) &&
    typeof record === "object";
  const problem = valid ? invalidPost(state, record as Record<string, unknown>) : "the request is not valid";
  if (problem !== undefined || typeof rkey !== "string")
    return failing(state, request, 400, "InvalidRequest");
  if (state.records.has(rkey) && state.settings.duplicateRkey === "error") {
    return failing(state, request, 400, "InvalidRequest");
  }
  const value = record as Record<string, unknown>;
  const stored = { uri: uriOf(rkey), cid: cidOf(JSON.stringify(value)), value };
  state.records.set(rkey, stored);
  context.effect();
  return { status: 200, body: { uri: stored.uri, cid: stored.cid } };
}

function getRecord(state: State, request: Request): SimReply {
  const refused = guard(state, "pds", request);
  if (refused) return refused;
  const rkey = request.query.get("rkey") ?? "";
  const known = request.query.get("repo") === WORLD.did && request.query.get("collection") === POST;
  const found = known ? state.records.get(rkey) : undefined;
  return found === undefined ? fail(400, "RecordNotFound") : { status: 200, body: found };
}

function deleteRecord(state: State, request: Request, context: Context): SimReply {
  const refused = guard(state, "pds", request);
  if (refused) return refused;
  const { rkey } = jsonBody(request) ?? {};
  if (typeof rkey === "string" && state.records.delete(rkey)) context.effect();
  return { status: 200, body: {} };
}

function uploadBlob(state: State, request: Request): SimReply {
  const refused = guard(state, "pds", request);
  if (refused) return refused;
  const mimeType = request.headers["content-type"] ?? "";
  if (!mimeType.startsWith("image/") || request.body.length === 0) return fail(400, "InvalidRequest");
  if (request.body.length > MAX_IMAGE_BYTES) return fail(413, "PayloadTooLarge");
  const cid = cidOf(request.body.toString("base64"));
  state.blobs.set(cid, request.body.length);
  return {
    status: 200,
    body: { blob: { $type: "blob", ref: { $link: cid }, mimeType, size: request.body.length } },
  };
}

const answerTo = (fault: MatrixFault) => {
  if (fault.kind !== "respond") return fault;
  return {
    kind: "respond" as const,
    status: fault.status,
    body: {
      error: fault.providerCode ?? "InternalServerError",
      ...(fault.echoId === undefined ? {} : { id: fault.echoId }),
    },
    ...(fault.retryAfter === undefined ? {} : { headers: { "retry-after": fault.retryAfter } }),
    ...(fault.afterEffect === undefined ? {} : { afterEffect: fault.afterEffect }),
  };
};

const storedPost = ({ uri, value }: StoredRecord): StoredPost => {
  const reply = value.reply as { parent?: { uri?: string } } | undefined;
  return {
    externalId: uri,
    text: String(value.text),
    ...(reply?.parent?.uri === undefined ? {} : { replyToExternalId: reply.parent.uri }),
  };
};

export async function startBlueskySimulator(options: BlueskySimulatorOptions): Promise<BlueskySimulator> {
  const { now, ...settings } = options;
  const state: State = {
    now,
    settings,
    nonces: { auth: fresh(settings, "auth"), pds: fresh(settings, "pds") },
    proofs: new Set(),
    pushed: [],
    records: new Map(),
    blobs: new Map(),
    created: 0,
    counter: 0,
  };
  const simulator = await startSimulator({
    ...document(state),
    ...authorizationServer(state),
    [ROUTES.commit]: (request, context) => createRecord(state, request, context),
    [ROUTES.readBack]: (request) => getRecord(state, request),
    [ROUTES.delete]: (request, context) => deleteRecord(state, request, context),
    [ROUTES.upload]: (request) => uploadBlob(state, request),
    "GET /xrpc/com.atproto.server.getSession": (request) =>
      guard(state, "pds", request) ?? { status: 200, body: { did: WORLD.did, handle: WORLD.handle } },
  });
  return {
    ...simulator,
    arm(operation, fault): void {
      // The matrix plays "the post is not there" as a 404 on a delete: here that post is really gone, so the read that
      // follows a 404 on a delete finds it gone too.
      if (operation === "delete" && fault.kind === "respond" && fault.status === 404) state.records.clear();
      simulator.faults.failNext(ROUTES[operation], answerTo(fault));
    },
    stored: () => [...state.records.values()].map(storedPost),
    created: () => state.created,
    records: () => state.records,
  };
}
