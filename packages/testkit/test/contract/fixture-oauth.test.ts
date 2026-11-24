import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isFetchBlockedPort, listenLoopback } from "@shoutory/provider-sdk/loopback";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtureOAuthManifest } from "../../src/fixture-oauth/manifest.js";
import { startFixtureOAuthSimulator } from "../../src/fixture-oauth/simulator.js";
import { startOAuthFake } from "../../src/oauth-fake/server.js";
import { type RecordedExchange, scrubExchange } from "../../src/recorded/scrubber.js";

const CLIENT = "client-1";
const REDIRECT = "http://127.0.0.1:9/callback";
const STATE = "state-1";

// The verifier is made at run time, so no secret-shaped literal sits in the source.
const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");

type Fake = Awaited<ReturnType<typeof startOAuthFake>>;
let fake: Fake;
let nowMs: number;
let requireDpop = false;

beforeEach(async () => {
  nowMs = Date.parse("2026-11-21T00:00:00Z");
  fake = await startOAuthFake({ now: () => new Date(nowMs), requireDpop });
});

afterEach(async () => {
  await fake.close();
});

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

const authorizationFields = (challenge: string, overrides: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: CLIENT,
  redirect_uri: REDIRECT,
  state: STATE,
  code_challenge: challenge,
  code_challenge_method: "S256",
  ...overrides,
});

let recording: RecordedExchange[] | undefined;
async function send(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { redirect: "manual", ...init });
  recording?.push({
    request: {
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    },
    response: {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.clone().text(),
    },
  });
  return response;
}

const push = (fields: Record<string, string>) => send(`${fake.url}/par`, form(fields));
const authorizeWith = (query: Record<string, string>) =>
  send(`${fake.url}/authorize?${new URLSearchParams(query)}`);
const token = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const request = form(fields);
  return send(`${fake.url}/token`, { ...request, headers: { ...request.headers, ...headers } });
};

async function codeFor(challenge: string): Promise<string> {
  const pushed = (await (await push(authorizationFields(challenge))).json()) as { request_uri: string };
  const redirect = await authorizeWith({ client_id: CLIENT, request_uri: pushed.request_uri });
  const code = new URL(redirect.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("the authorization answer carried no code");
  return code;
}

const exchange = (code: string, codeVerifier: string, headers: Record<string, string> = {}) =>
  token(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    },
    headers,
  );

describe("the oauth fake", () => {
  it("the code flow with PKCE and PAR returns tokens", async () => {
    const secret = verifier();
    const pushed = await push(authorizationFields(challengeOf(secret)));
    expect(pushed.status).toBe(201);
    const { request_uri, expires_in } = (await pushed.json()) as { request_uri: string; expires_in: number };
    expect(expires_in).toBeGreaterThan(0);
    const redirect = await authorizeWith({ client_id: CLIENT, request_uri });
    expect(redirect.status).toBe(302);
    const back = new URL(redirect.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe(STATE);
    expect(back.searchParams.get("iss")).toBe(fake.url);
    const answer = await exchange(back.searchParams.get("code") ?? "", secret);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toMatchObject({
      token_type: "Bearer",
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });
});

describe("the oauth fake's refusals", () => {
  it.each([
    [
      "a verifier that does not match",
      async () => exchange(await codeFor(challengeOf(verifier())), verifier()),
    ],
    [
      "a verifier that is too short",
      async () => {
        const short = "short";
        return exchange(await codeFor(challengeOf(short)), short);
      },
    ],
  ])("%s is refused with invalid_grant and issues no token", async (_name, attempt) => {
    const answer = await attempt();
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid_grant" });
  });

  it("a challenge method other than S256 is refused", async () => {
    const answer = await push(
      authorizationFields(challengeOf(verifier()), { code_challenge_method: "plain" }),
    );
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid_request" });
  });
});

describe("the oauth fake's single-use and expiry", () => {
  it.each([
    ["a replayed code", 0],
    ["an expired code", 61_000],
  ])("%s is refused", async (_name, waitMs) => {
    const secret = verifier();
    const code = await codeFor(challengeOf(secret));
    if (waitMs === 0) expect((await exchange(code, secret)).status).toBe(200);
    nowMs += waitMs;
    const answer = await exchange(code, secret);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid_grant" });
  });

  it.each([
    ["a replayed request_uri", 0, "invalid_request_uri"],
    ["an expired request_uri", 91_000, "invalid_request_uri"],
  ])("%s is refused at /authorize", async (_name, waitMs, error) => {
    const pushed = (await (await push(authorizationFields(challengeOf(verifier())))).json()) as {
      request_uri: string;
    };
    const query = { client_id: CLIENT, request_uri: pushed.request_uri };
    if (waitMs === 0) expect((await authorizeWith(query)).status).toBe(302);
    nowMs += waitMs;
    const answer = await authorizeWith(query);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error });
  });

  it("a request_uri inside a pushed body is refused", async () => {
    const answer = await push({
      ...authorizationFields(challengeOf(verifier())),
      request_uri: "urn:ietf:params:oauth:request_uri:par-9",
    });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid_request" });
  });
});

// Keys are made at run time. A proof is built piece by piece so a test can break exactly one.
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = keys.publicKey.export({ format: "jwk" });
const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
let jtiCounter = 0;

interface ProofParts {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  signedBy?: typeof keys.privateKey;
  signature?: string;
}

function proofWith(nonce: string | undefined, parts: ProofParts = {}): string {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk, ...parts.header };
  const claims = {
    jti: `jti-${++jtiCounter}`,
    htm: "POST",
    htu: `${fake.url}/token`,
    iat: Math.floor(nowMs / 1000),
    ...(nonce === undefined ? {} : { nonce }),
    ...parts.claims,
  };
  const input = `${segment(header)}.${segment(claims)}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: parts.signedBy ?? keys.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${input}.${parts.signature ?? signature}`;
}

async function serverNonce(): Promise<string> {
  const refused = await exchange("code-0", "unused", { dpop: proofWith(undefined) });
  return refused.headers.get("dpop-nonce") ?? "";
}

function withDpop() {
  beforeAll(() => {
    requireDpop = true;
  });
  afterAll(() => {
    requireDpop = false;
  });
}

describe("the oauth fake with DPoP required", () => {
  withDpop();

  it("a token request without a nonce is refused with use_dpop_nonce and succeeds on retry", async () => {
    const secret = verifier();
    const code = await codeFor(challengeOf(secret));
    const refused = await exchange(code, secret, { dpop: proofWith(undefined) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "use_dpop_nonce" });
    const nonce = refused.headers.get("dpop-nonce");
    expect(nonce).toBeTruthy();
    const answer = await exchange(code, secret, { dpop: proofWith(nonce ?? "") });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ token_type: "DPoP" });
  });
});

describe("the oauth fake refuses a defective DPoP proof", () => {
  withDpop();

  // Each defect alone makes the proof invalid; the nonce is the server's, so nothing else is wrong.
  const DEFECTS: [string, (nonce: string) => Promise<string | undefined>][] = [
    ["no proof at all", async () => undefined],
    ["a wrong htm", async (nonce) => proofWith(nonce, { claims: { htm: "GET" } })],
    ["a wrong htu", async (nonce) => proofWith(nonce, { claims: { htu: `${fake.url}/other` } })],
    ["a wrong typ", async (nonce) => proofWith(nonce, { header: { typ: "jwt" } })],
    ["alg none", async (nonce) => proofWith(nonce, { header: { alg: "none" }, signature: "" })],
    [
      "a private d in the jwk",
      async (nonce) => proofWith(nonce, { header: { jwk: { ...publicJwk, d: "private-member-1" } } }),
    ],
    ["a bad signature", async (nonce) => proofWith(nonce, { signedBy: otherKeys.privateKey })],
    [
      "an iat outside the window",
      async (nonce) => proofWith(nonce, { claims: { iat: Math.floor(nowMs / 1000) - 120 } }),
    ],
    [
      "a replayed jti",
      async (nonce) => {
        const proof = proofWith(nonce);
        const secret = verifier();
        const spent = await exchange(await codeFor(challengeOf(secret)), secret, { dpop: proof });
        expect(spent.status).toBe(200);
        return proof;
      },
    ],
  ];

  it.each(DEFECTS)("a proof with %s is refused with invalid_dpop_proof", async (_name, build) => {
    const proof = await build(await serverNonce());
    const secret = verifier();
    const code = await codeFor(challengeOf(secret));
    const answer = await exchange(code, secret, proof === undefined ? {} : { dpop: proof });
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: "invalid_dpop_proof" });
  });
});

type Tokens = { access_token: string; refresh_token?: string };

async function connect(): Promise<Tokens> {
  const secret = verifier();
  const answer = await exchange(await codeFor(challengeOf(secret)), secret);
  return (await answer.json()) as Tokens;
}
const refreshWith = (refreshToken: string, headers: Record<string, string> = {}) =>
  token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT }, headers);

let oauth: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
function withFixtureOAuth() {
  beforeEach(async () => {
    await fake.close();
    oauth = await startFixtureOAuthSimulator({ now: () => new Date(nowMs), requireDpop });
    fake = oauth;
  });
}

describe("fixture-oauth refresh", () => {
  withFixtureOAuth();

  it("declares a manifest the schema accepts", () => {
    expect(manifestSchema.safeParse(fixtureOAuthManifest).success).toBe(true);
  });

  it("a refresh rotates the token and the old one is refused with invalid_grant", async () => {
    const first = await connect();
    const answer = await refreshWith(first.refresh_token ?? "");
    expect(answer.status).toBe(200);
    const second = (await answer.json()) as Tokens;
    expect(second.refresh_token).toEqual(expect.any(String));
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    const replay = await refreshWith(first.refresh_token ?? "");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
    expect((await refreshWith(second.refresh_token ?? "")).status).toBe(200);
  });

  it("an answer without a new refresh token appears only when armed", async () => {
    const first = (await (await refreshWith((await connect()).refresh_token ?? "")).json()) as Tokens;
    expect(first.refresh_token).toEqual(expect.any(String));
    oauth.omitNextRefreshToken();
    const armed = (await (await refreshWith(first.refresh_token ?? "")).json()) as Tokens;
    expect(armed).not.toHaveProperty("refresh_token");
    expect(armed.access_token).toEqual(expect.any(String));
    // The token that was used was not rotated, so it still works, and the next answer is normal again.
    const after = (await (await refreshWith(first.refresh_token ?? "")).json()) as Tokens;
    expect(after.refresh_token).toEqual(expect.any(String));
  });
});

describe("fixture-oauth token route failures", () => {
  withFixtureOAuth();

  const FAULTS: [string, () => Promise<void>][] = [
    [
      "a 503 before the grant ran leaves the refresh token usable",
      async () => {
        const held = (await connect()).refresh_token ?? "";
        oauth.faults.failNext("POST /token", { kind: "respond", status: 503 });
        expect((await refreshWith(held)).status).toBe(503);
        expect((await refreshWith(held)).status).toBe(200);
      },
    ],
    [
      "a 503 after the grant ran has spent the refresh token",
      async () => {
        const held = (await connect()).refresh_token ?? "";
        oauth.faults.failNext("POST /token", { kind: "respond", status: 503, afterEffect: true });
        expect((await refreshWith(held)).status).toBe(503);
        expect(await (await refreshWith(held)).json()).toEqual({ error: "invalid_grant" });
      },
    ],
    [
      "a hang is no answer and leaves the refresh token usable",
      async () => {
        const held = (await connect()).refresh_token ?? "";
        oauth.faults.failNext("POST /token", { kind: "hang" });
        const request = form({ grant_type: "refresh_token", refresh_token: held, client_id: CLIENT });
        await expect(
          fetch(`${fake.url}/token`, { ...request, signal: AbortSignal.timeout(100) }),
        ).rejects.toMatchObject({ name: "TimeoutError" });
        expect((await refreshWith(held)).status).toBe(200);
      },
    ],
  ];

  it.each(FAULTS)("%s", async (_name, play) => {
    await play();
  });
});

const privateJwk = keys.privateKey.export({ format: "jwk" });
const FORMS: [string, (secret: string) => string][] = [
  ["raw", (s) => s],
  ["percent-encoded", (s) => encodeURIComponent(s)],
  ["hex", (s) => Buffer.from(s).toString("hex")],
  ["base64", (s) => Buffer.from(s).toString("base64")],
  ["base64url", (s) => Buffer.from(s).toString("base64url")],
  ["JSON-escaped", (s) => JSON.stringify(s).slice(1, -1)],
];

async function recordedFlow(): Promise<{ exchanges: RecordedExchange[]; secrets: Record<string, string> }> {
  recording = [];
  const nonce = await serverNonce();
  const secret = verifier();
  const code = await codeFor(challengeOf(secret));
  const proofs = [proofWith(nonce), proofWith(nonce)];
  const first = (await (await exchange(code, secret, { dpop: proofs[0] ?? "" })).json()) as Tokens;
  const second = (await (
    await refreshWith(first.refresh_token ?? "", { dpop: proofs[1] ?? "" })
  ).json()) as Tokens;
  recording.push({
    request: {
      method: "POST",
      url: `${fake.url}/keys`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(privateJwk),
    },
    response: { status: 204, headers: {} },
  });
  const exchanges = recording;
  recording = undefined;
  return {
    exchanges,
    secrets: {
      code,
      state: STATE,
      "code verifier": secret,
      "access token": first.access_token,
      "refresh token": first.refresh_token ?? "",
      "rotated access token": second.access_token,
      "rotated refresh token": second.refresh_token ?? "",
      "DPoP proof": proofs[0] ?? "",
      "second DPoP proof": proofs[1] ?? "",
      "jwk private member": privateJwk.d ?? "",
    },
  };
}

const everyString = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(everyString)
      : [];

describe("a recording of the oauth flow", () => {
  withDpop();
  withFixtureOAuth();

  it.each([
    "code",
    "state",
    "code verifier",
    "access token",
    "refresh token",
    "rotated access token",
    "rotated refresh token",
    "DPoP proof",
    "second DPoP proof",
    "jwk private member",
  ])("keeps no %s in any form once scrubbed", async (name) => {
    const { exchanges, secrets } = await recordedFlow();
    const text = everyString(exchanges.map(scrubExchange)).join("\n");
    const secret = secrets[name] ?? "";
    expect(secret.length).toBeGreaterThan(0);
    for (const [form, encode] of FORMS) {
      expect(text, `${name} survived as ${form}`).not.toContain(encode(secret));
    }
    expect(text).toContain(CLIENT);
  });
});

describe("the oauth fake's error answers", () => {
  // Values a caller sends that a refusal must never send back.
  const PLANTED = "planted-credential-1";
  const REFUSALS: [string, () => Promise<Response>][] = [
    ["a code", () => exchange(PLANTED, verifier())],
    ["a verifier", async () => exchange(await codeFor(challengeOf(verifier())), PLANTED)],
    ["a refresh token", () => refreshWith(PLANTED)],
    ["a grant type", () => token({ grant_type: PLANTED })],
    ["a request_uri", () => authorizeWith({ client_id: CLIENT, request_uri: PLANTED })],
    ["a challenge", () => push(authorizationFields(PLANTED, { code_challenge_method: PLANTED }))],
  ];

  it.each(REFUSALS)("echo no %s", async (_name, attempt) => {
    const answer = await attempt();
    expect(answer.status).toBeGreaterThanOrEqual(400);
    const seen = `${await answer.text()}\n${JSON.stringify(Object.fromEntries(answer.headers))}`;
    expect(seen).not.toContain(PLANTED);
  });
});

// A simulator that fetch cannot reach is a defect of the test host, not a flake: the loopback listener hands back a
// port the Fetch Standard allows, however the operating system assigned the first one. The first draw is forced onto
// a blocked port (the real server binds it), then the listener must release it and take another.
describe("the loopback listener", () => {
  it.each([6000, 6665, 10080])(
    "never returns the Fetch-blocked port %i, and releases it",
    async (blocked) => {
      const server = createServer();
      const listen = server.listen.bind(server) as (port: number, host: string, done: () => void) => Server;
      let drawn = 0;
      server.listen = ((_port: number, host: string, done: () => void) =>
        listen(drawn++ === 0 ? blocked : 0, host, done)) as typeof server.listen;
      const port = await listenLoopback(server);
      try {
        expect(port).not.toBe(blocked);
        expect(isFetchBlockedPort(port)).toBe(false);
        expect(drawn).toBeGreaterThanOrEqual(2);
        const taken = createServer();
        await new Promise<void>((done) => taken.listen(blocked, "127.0.0.1", done));
        await new Promise<void>((done) => taken.close(() => done()));
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );
});
