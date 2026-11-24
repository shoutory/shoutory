import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open, SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { startFixtureOAuthSimulator } from "@shoutory/testkit/fixture-oauth/simulator";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialService } from "../../src/channels/credentials.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import { FAKE_CLIENT } from "../support/oauth-fake.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, keys, ORIGIN, PEPPER, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
const FIRST = "fixture_oauth";
const SECOND = "fixture_oauth2";
const manifestOf = (id: string) => manifestSchema.parse({ ...fixtureOAuthManifest, id });
let fx: Fixture;
let sim: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
let org: string;
let admin: User;
let admin2: User;
let workspace: string;
let other: string;
const adapter = () => createFixtureAdapter({ baseUrl: sim.url, clientId: FAKE_CLIENT, issuer: sim.url });

beforeAll(async () => {
  sim = await startFixtureOAuthSimulator({ now: () => new Date() });
  fx = await startFixture({
    channels: {
      providers: {
        [FIRST]: { adapter: adapter(), manifest: manifestOf(FIRST) },
        [SECOND]: { adapter: adapter(), manifest: manifestOf(SECOND) },
      },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "connect-founder");
  org = await seedOrganization(fx, founder.id);
  workspace = await seedWorkspace(fx, org);
  other = await seedWorkspace(fx, org);
  [admin, admin2] = [await signedUser(fx, "connect-admin"), await signedUser(fx, "connect-admin2")];
  for (const who of [admin, admin2]) await addWorkspaceMember(fx, workspace, who.id, "admin");
  await addWorkspaceMember(fx, other, admin.id, "admin");
}, 90_000);
afterAll(async () => {
  await sim.close();
  await fx.close();
});

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
// Only code exchanges: a refresh the health look may make is another grant at the same route.
const exchangeCalls = () =>
  sim.requests.filter(
    (r) =>
      r.method === "POST" &&
      r.path === "/token" &&
      new URLSearchParams(r.body.toString("utf8")).get("grant_type") === "authorization_code",
  );
const tokenCalls = () => exchangeCalls().length;
const inspectCalls = () => sim.requests.filter((r) => r.method === "GET" && r.path === "/v1/account").length;
const rawStartAs = (who: User | undefined, body: object = {}, ws = workspace) =>
  fx.request(`/api/v1/workspaces/${ws}/connect/${FIRST}/start`, {
    method: "POST",
    headers: who ? { cookie: who.cookie } : {},
    body,
  });
const rawCallbackAs = (who: User | undefined, params: URLSearchParams, provider = FIRST) =>
  fx.request(`/api/v1/connect/${provider}/callback?${params}`, {
    headers: who ? { cookie: who.cookie } : {},
  });
// The shared users make far more than 10 starts and 20 callbacks between them, so every call but the bucket rows' own
// first refills the user's bucket: what these rows test is not the limit.
const refill = (who: User | undefined, scope: "connect_start" | "connect_callback") =>
  who
    ? q("DELETE FROM app.rate_buckets WHERE scope = $1 AND key = $2", [
        scope,
        fx.auth.bucketKey(scope, who.id),
      ])
    : undefined;
const startAs = async (who: User | undefined, body: object = {}, ws = workspace) => {
  await refill(who, "connect_start");
  return rawStartAs(who, body, ws);
};
const callbackAs = async (who: User | undefined, params: URLSearchParams, provider = FIRST) => {
  await refill(who, "connect_callback");
  return rawCallbackAs(who, params, provider);
};
const authorizeUrl = async (answer: Response) =>
  ((await answer.json()) as { data: { authorize_url: string } }).data.authorize_url;
const approved = async (url: string | URL) =>
  new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "").searchParams;

interface Begun {
  url: string;
  state: string;
  redirect: URLSearchParams;
}
async function begin(who: User, body: object = {}, tweak?: (query: URLSearchParams) => void): Promise<Begun> {
  const answer = await startAs(who, body);
  expect(answer.status).toBe(200);
  const url = await authorizeUrl(answer);
  const target = new URL(url);
  const state = target.searchParams.get("state") ?? "";
  tweak?.(target.searchParams);
  return { url, state, redirect: await approved(target) };
}
async function ownWorkspace(): Promise<string> {
  const ws = await seedWorkspace(fx, org);
  await addWorkspaceMember(fx, ws, admin.id, "admin");
  return ws;
}

function outcomeOf(answer: Response) {
  const location = new URL(answer.headers.get("location") ?? "", ORIGIN);
  const get = (name: string) => location.searchParams.get(name);
  return {
    status: answer.status,
    path: location.pathname,
    reason: get("reason"),
    channel: get("channel"),
    message: get("message"),
    workspace: get("workspace"),
    keys: [...new Set(location.searchParams.keys())].sort(),
  };
}
const q = <T>(sql: string, params: unknown[] = []) =>
  fx.admin(async (c) => (await c.query(sql, params)).rows as T[]);
const countOf = async (table: string, ws: string) =>
  Number(
    (await q<{ n: string }>(`SELECT count(*) AS n FROM app.${table} WHERE workspace_id = $1`, [ws]))[0]?.n,
  );
const stored = async (ws = workspace) => [
  await countOf("channels", ws),
  await countOf("channel_credentials", ws),
];
const refusalsOf = (requestId: string | null) =>
  q<{ workspace_id: string | null; metadata: { outcome?: string } }>(
    "SELECT workspace_id, metadata FROM app.audit_logs WHERE request_id = $1 AND action = 'channel.connect_refused'",
    [requestId],
  );
const flowOf = async (state: string) =>
  (
    await q<{ id: string; consumed_at: Date | null }>(
      "SELECT * FROM app.oauth_flows WHERE state_hash = sha256($1::bytea)",
      [Buffer.from(state, "base64url")],
    )
  )[0];

const failureLines = (mark: number) =>
  fx.logged
    .slice(mark)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "connect_failed")
    .map(({ event, providerId, step, errorClass }) => ({ event, providerId, step, errorClass }));

async function verifierOf(state: string): Promise<string> {
  const id = (await flowOf(state))?.id ?? "";
  const [flow] = await q<Record<string, Buffer | number | string>>(
    "SELECT * FROM app.oauth_flows WHERE id = $1",
    [id],
  );
  const [salt] = await q<{ salt: Buffer }>(
    "SELECT salt FROM app.workspace_key_salts WHERE workspace_id = $1",
    [workspace],
  );
  const aad = {
    formatVersion: 1,
    scopeId: workspace,
    ownerId: id,
    credentialKind: "oauth_flow" as const,
    generation: 1,
  };
  const sealed = {
    formatVersion: flow?.format_version as number,
    keyId: flow?.key_id as string,
    iv: flow?.iv as Buffer,
    ciphertext: flow?.ciphertext as Buffer,
    tag: flow?.auth_tag as Buffer,
    wrapIv: flow?.wrap_iv as Buffer,
    wrapTag: flow?.wrap_tag as Buffer,
    wrappedDek: flow?.wrapped_dek as Buffer,
  };
  return JSON.parse(open(sealed, aad, keys, salt?.salt).expose()).code_verifier;
}

describe("start", () => {
  it("answers the authorize URL with the PKCE challenge and the redirect URI, and stores the verifier sealed under the flow id", async () => {
    const { url, state } = await begin(admin);
    const target = new URL(url);
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      response_type: "code",
      client_id: FAKE_CLIENT,
      redirect_uri: `${ORIGIN}/api/v1/connect/${FIRST}/callback`,
      code_challenge_method: "S256",
    });
    expect(challengeOf(await verifierOf(state))).toBe(target.searchParams.get("code_challenge"));
  }, 60_000);

  it.each([
    ["an Editor", "editor", 403],
    ["a Viewer", "viewer", 403],
  ])(
    "%s may not start a connect and no flow is stored",
    async (_who, role, status) => {
      const member = await signedUser(fx, `connect-${role}`);
      await addWorkspaceMember(fx, workspace, member.id, role);
      const flows = () => q("SELECT 1 FROM app.oauth_flows WHERE user_id = $1", [member.id]);
      const before = await flows();
      expect((await startAs(member)).status).toBe(status);
      expect(await flows()).toEqual(before);
    },
    60_000,
  );

  it("refuses a caller who is not signed in", async () => {
    expect((await startAs(undefined)).status).toBe(401);
  });
});

interface Run {
  who: User | undefined;
  params: URLSearchParams;
  provider?: string;
}
const unknownState = () => new URLSearchParams({ code: "c", state: randomBytes(32).toString("base64url") });
const REFUSED_STATES: [kind: string, reason: string, scenario: () => Promise<Run>][] = [
  ["unknown_state", "refused", async () => ({ who: admin, params: unknownState() })],
  // A real state spelled another way (a padded copy) is not the state the person was given.
  [
    "unknown_state",
    "refused",
    async () => {
      const { state } = await begin(admin);
      return { who: admin, params: new URLSearchParams({ code: "c", state: `${state}=` }) };
    },
  ],
  [
    "consumed",
    "start_again",
    async () => {
      const flow = await begin(admin);
      expect(outcomeOf(await callbackAs(admin, flow.redirect)).channel).not.toBeNull();
      return { who: admin, params: flow.redirect };
    },
  ],
  [
    "expired",
    "start_again",
    async () => {
      const flow = await begin(admin);
      const id = (await flowOf(flow.state))?.id;
      await q("UPDATE app.oauth_flows SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
      return { who: admin, params: flow.redirect };
    },
  ],
  [
    "wrong_provider",
    "refused",
    async () => ({ who: admin, params: (await begin(admin)).redirect, provider: SECOND }),
  ],
  ["wrong_user", "refused", async () => ({ who: admin2, params: (await begin(admin)).redirect })],
  [
    "not_admin",
    "refused",
    async () => {
      const leaving = await signedUser(fx, "connect-leaving");
      await addWorkspaceMember(fx, workspace, leaving.id, "admin");
      const flow = await begin(leaving);
      const gone = "DELETE FROM app.workspace_members WHERE workspace_id = $1 AND user_id = $2";
      await q(gone, [workspace, leaving.id]);
      return { who: leaving, params: flow.redirect };
    },
  ],
  [
    "ambiguous",
    "refused",
    async () => {
      const flow = await begin(admin);
      await q(
        `INSERT INTO app.oauth_flows (workspace_id, user_id, provider_id, state_hash, format_version, key_id, iv,
           ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, expires_at)
         SELECT $2, user_id, provider_id, state_hash, format_version, key_id, iv, ciphertext, auth_tag, wrap_iv,
           wrap_tag, wrapped_dek, expires_at FROM app.oauth_flows WHERE id = $1`,
        [(await flowOf(flow.state))?.id, other],
      );
      return { who: admin, params: flow.redirect };
    },
  ],
  [
    "wrong_instance_host",
    "refused",
    async () => {
      const flow = await begin(admin, { instance_host: "a.example" });
      const params = new URLSearchParams(flow.redirect);
      params.set("instance_host", "b.example");
      return { who: admin, params };
    },
  ],
];

describe("the callback refuses a state that is not its own", () => {
  it.each(REFUSED_STATES)(
    "%s: audited, nothing stored, no token call, reason %s",
    async (kind, reason, scenario) => {
      const run = await scenario();
      const [before, exchanges] = [await stored(), tokenCalls()];
      const answer = await callbackAs(run.who, run.params, run.provider);
      expect(outcomeOf(answer)).toMatchObject({
        status: 302,
        path: "/connect/result",
        reason,
        channel: null,
      });
      expect(await refusalsOf(answer.headers.get("x-request-id"))).toEqual([
        // No single workspace is the subject of an unknown or an ambiguous state: both are audited in the instance chain.
        {
          workspace_id: ["unknown_state", "ambiguous"].includes(kind) ? null : expect.any(String),
          metadata: { outcome: kind },
        },
      ]);
      expect([await stored(), tokenCalls()]).toEqual([before, exchanges]);
    },
    90_000,
  );
});

describe("the callback needs a live session", () => {
  it("a callback with no session answers sign_in, never reaches the take and writes no audit row", async () => {
    const flow = await begin(admin);
    const answer = await callbackAs(undefined, flow.redirect);
    expect(outcomeOf(answer)).toMatchObject({ status: 302, path: "/connect/result", reason: "sign_in" });
    expect(await refusalsOf(answer.headers.get("x-request-id"))).toEqual([]);
    expect((await flowOf(flow.state))?.consumed_at).toBeNull();
  }, 60_000);

  it("a callback whose session has expired answers sign_in, writes no audit row and leaves the flow unspent", async () => {
    const lapsing = await signedUser(fx, "connect-lapsing");
    await addWorkspaceMember(fx, workspace, lapsing.id, "admin");
    const flow = await begin(lapsing);
    const lapse = "UPDATE auth.session SET expires_at = now() - interval '1 hour' WHERE user_id = $1";
    await q(lapse, [lapsing.id]);
    const answer = await callbackAs(lapsing, flow.redirect);
    expect(outcomeOf(answer)).toMatchObject({ status: 302, path: "/connect/result", reason: "sign_in" });
    expect(await refusalsOf(answer.headers.get("x-request-id"))).toEqual([]);
    expect((await flowOf(flow.state))?.consumed_at).toBeNull();
  }, 60_000);
});

describe("a reconnect names a channel of the workspace and the provider", () => {
  // Refused at start, so a token for a channel that can never take it is never fetched; the answer is the one
  // start gives for a channel of another workspace.
  it("start refuses a reconnect of another provider's channel and stores no flow", async () => {
    const plant = (ws: string, provider: string) =>
      q<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name)
         VALUES ($1, $2, 'profile', $3, 'reconnect target') RETURNING id`,
        [ws, provider, randomUUID()],
      );
    const [otherProvider] = await plant(workspace, SECOND);
    const [otherWorkspace] = await plant(other, FIRST);
    const flows = async () =>
      (await q("SELECT 1 FROM app.oauth_flows WHERE user_id = $1", [admin.id])).length;
    const [before, exchanges] = [await flows(), tokenCalls()];
    const answers = [
      await startAs(admin, { channel_id: otherProvider?.id }),
      await startAs(admin, { channel_id: otherWorkspace?.id }),
    ];
    const errors = await Promise.all(answers.map((a) => a.json() as Promise<{ error: { code: string } }>));
    expect(answers.map((a) => a.status)).toEqual([404, 404]);
    expect(errors[0]?.error.code).toBe(errors[1]?.error.code);
    expect([await flows(), tokenCalls()]).toEqual([before, exchanges]);
  }, 60_000);
});

describe("the code exchange", () => {
  it("a PKCE verifier that does not match the challenge stores no credential", async () => {
    const mismatched = challengeOf("a-different-verifier-that-is-long-enough-1234567890abc");
    const flow = await begin(admin, {}, (query) => query.set("code_challenge", mismatched));
    const [before, exchanges, mark] = [await stored(), tokenCalls(), fx.logged.length];
    const seen = outcomeOf(await callbackAs(admin, flow.redirect));
    expect(seen).toMatchObject({ reason: "failed", channel: null });
    expect(tokenCalls()).toBe(exchanges + 1);
    expect(await stored()).toEqual(before);
    expect(failureLines(mark)).toEqual([
      { event: "connect_failed", providerId: FIRST, step: "exchange", errorClass: expect.any(String) },
    ]);
  }, 60_000);

  it("a token answer cut short ends as a failed redirect, never a JSON 500, and the flow is spent", async () => {
    const flow = await begin(admin);
    sim.faults.failNext("POST /token", { kind: "truncate" });
    const [before, mark] = [await stored(), fx.logged.length];
    const answer = await callbackAs(admin, flow.redirect);
    expect(outcomeOf(answer)).toMatchObject({ status: 302, reason: "failed", channel: null });
    expect(await stored()).toEqual(before);
    expect((await flowOf(flow.state))?.consumed_at).not.toBeNull();
    expect(failureLines(mark)).toHaveLength(1);
  }, 60_000);
});

describe("the callback's own checks", () => {
  it.each([
    ["no iss", (query: URLSearchParams) => query.delete("iss")],
    ["another iss", (query: URLSearchParams) => query.set("iss", "http://evil.example")],
  ])(
    "%s is refused before the code exchange",
    async (_name, change) => {
      const flow = await begin(admin);
      change(flow.redirect);
      const exchanges = tokenCalls();
      const seen = outcomeOf(await callbackAs(admin, flow.redirect));
      expect(seen).toMatchObject({ reason: "refused", channel: null });
      expect(tokenCalls()).toBe(exchanges);
      expect((await flowOf(flow.state))?.consumed_at).not.toBeNull();
    },
    60_000,
  );

  it("a callback with neither a code nor an error is a failed connect that spends the flow and makes no token call", async () => {
    const flow = await begin(admin);
    flow.redirect.delete("code");
    const exchanges = tokenCalls();
    const seen = outcomeOf(await callbackAs(admin, flow.redirect));
    expect(seen).toMatchObject({ reason: "failed", channel: null });
    expect(tokenCalls()).toBe(exchanges);
    expect((await flowOf(flow.state))?.consumed_at).not.toBeNull();
  }, 60_000);

  it("a provider error with a usable state spends the flow, stores nothing, writes no audit row and shows bounded text", async () => {
    const flow = await begin(admin);
    const [before, exchanges] = [await stored(), tokenCalls()];
    const params = new URLSearchParams({
      error: "access_denied",
      error_description: `The user said no\u0007${"x".repeat(400)}`,
      state: flow.state,
      iss: sim.url,
    });
    const answer = await callbackAs(admin, params);
    const seen = outcomeOf(answer);
    expect(seen).toMatchObject({ reason: "provider_error", channel: null });
    expect(seen.message).toBe(`The user said no${"x".repeat(184)}`);
    expect(await refusalsOf(answer.headers.get("x-request-id"))).toEqual([]);
    expect([await stored(), tokenCalls()]).toEqual([before, exchanges]);
    expect((await flowOf(flow.state))?.consumed_at).not.toBeNull();
    expect(outcomeOf(await callbackAs(admin, flow.redirect)).reason).toBe("start_again");
  }, 60_000);
});

const taken = async (change: (query: URLSearchParams) => void): Promise<Run> => {
  const flow = await begin(admin);
  change(flow.redirect);
  return { who: admin, params: flow.redirect };
};
const providerError = async (): Promise<Run> => {
  const flow = await begin(admin);
  return {
    who: admin,
    params: new URLSearchParams({ error: "access_denied", state: flow.state, iss: sim.url }),
  };
};
const foreignError = async (): Promise<Run> => {
  const run = await providerError();
  run.params.set("iss", "http://evil.example");
  return run;
};

// `workspace` is the flow's own workspace, never a value of the callback's query.
describe("the callback redirect carries exactly the keys of its outcome", () => {
  let mine = "";
  beforeAll(async () => {
    mine = await ownWorkspace();
  }, 60_000);
  it.each<[string, () => Promise<Run>, string[], string | null]>([
    [
      "connected",
      async () => ({
        who: admin,
        params: await approved(await authorizeUrl(await startAs(admin, {}, mine))),
      }),
      ["channel", "workspace"],
      "mine",
    ],
    ["provider_error", providerError, ["message", "reason", "workspace"], "workspace"],
    ["failed (no code)", () => taken((query) => query.delete("code")), ["reason", "workspace"], "workspace"],
    [
      "refused (another issuer)",
      () => taken((query) => query.set("iss", "http://evil.example")),
      ["reason", "workspace"],
      "workspace",
    ],
    ["refused (an error from another issuer)", foreignError, ["reason", "workspace"], "workspace"],
    [
      "a refused take (unknown state)",
      async () => ({ who: admin, params: unknownState() }),
      ["reason"],
      null,
    ],
    [
      "start_again (a spent flow)",
      async () => {
        const flow = await begin(admin);
        await callbackAs(admin, flow.redirect);
        return { who: admin, params: flow.redirect };
      },
      ["reason"],
      null,
    ],
    ["sign_in (no session)", async () => ({ who: undefined, params: unknownState() }), ["reason"], null],
  ])(
    "%s",
    async (_name, scenario, keys, from) => {
      const run = await scenario();
      const seen = outcomeOf(await callbackAs(run.who, run.params));
      expect(seen.keys).toEqual(keys);
      expect(seen.workspace).toBe(from === "workspace" ? workspace : from === "mine" ? mine : null);
    },
    60_000,
  );
});

describe("the callback redirect names the flow's own workspace and channel", () => {
  it("the workspace is the one the flow was started in, and a workspace or channel in the callback's query never reaches the redirect", async () => {
    const forged = { workspace: randomUUID(), channel: randomUUID() };
    const started = await approved(await authorizeUrl(await startAs(admin, {}, other)));
    for (const [key, value] of Object.entries(forged)) started.set(key, value);
    const seen = outcomeOf(await callbackAs(admin, started));
    expect(seen).toMatchObject({ workspace: other, keys: ["channel", "workspace"] });
    expect(seen.channel).not.toBe(forged.channel);
    expect(await countOf("channels", other)).toBeGreaterThan(0);
  }, 60_000);

  it("a reconnect that returns another account ends as wrong_account with the channel and the workspace, and stores nothing", async () => {
    const mine = await ownWorkspace();
    const [target] = await q<{ id: string }>(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name,
         connection_state)
       VALUES ($1, $2, 'profile', $3, 'reconnect target', 'needs_reconnect') RETURNING id`,
      [mine, FIRST, randomUUID()],
    );
    const started = await startAs(admin, { channel_id: target?.id }, mine);
    expect(started.status).toBe(200);
    const redirect = await approved(await authorizeUrl(started));
    const before = await stored(mine);
    const seen = outcomeOf(await callbackAs(admin, redirect));
    expect(seen).toMatchObject({
      status: 302,
      path: "/connect/result",
      reason: "wrong_account",
      channel: target?.id,
      workspace: mine,
    });
    expect(seen.keys).toEqual(["channel", "reason", "workspace"]);
    expect(await stored(mine)).toEqual(before);
    const state = "SELECT connection_state FROM app.channels WHERE id = $1";
    expect((await q<{ connection_state: string }>(state, [target?.id]))[0]?.connection_state).toBe(
      "needs_reconnect",
    );
  }, 60_000);
});

describe("a successful connect", () => {
  it("ends with one channel row, its first sealed credential and a stored health check time", async () => {
    const mine = await ownWorkspace();
    const redirect = await approved(await authorizeUrl(await startAs(admin, {}, mine)));
    const done = outcomeOf(await callbackAs(admin, redirect));
    expect(done).toMatchObject({ status: 302, path: "/connect/result", reason: null });
    const [row] = await q<Record<string, unknown>>("SELECT * FROM app.channels WHERE workspace_id = $1", [
      mine,
    ]);
    expect(row).toMatchObject({
      id: done.channel,
      provider_id: FIRST,
      connection_state: "connected",
      health: "ok",
    });
    expect(row?.health_checked_at).toBeInstanceOf(Date);
    expect(await countOf("channel_credentials", mine)).toBe(1);
  }, 60_000);

  it("two concurrent callbacks on one state end with one channel row and one exchange", async () => {
    const mine = await ownWorkspace();
    const redirect = await approved(await authorizeUrl(await startAs(admin, {}, mine)));
    const exchanges = tokenCalls();
    const answers = await Promise.all([callbackAs(admin, redirect), callbackAs(admin, redirect)]);
    const seen = answers.map(outcomeOf);
    expect(seen.filter((s) => s.channel !== null)).toHaveLength(1);
    expect(seen.filter((s) => s.reason === "start_again")).toHaveLength(1);
    expect(await countOf("channels", mine)).toBe(1);
    expect(tokenCalls()).toBe(exchanges + 1);
  }, 60_000);
});

describe("the health check after a connect", () => {
  const revoked = { kind: "respond" as const, status: 401, body: { error: { code: "grant_revoked" } } };
  it.each([
    { name: "one revoked answer, then ok", revokedAnswers: 1, health: "ok" },
    { name: "two revoked answers", revokedAnswers: 2, health: "failing" },
  ])(
    "$name ends as $health after two looks",
    async ({ revokedAnswers, health }) => {
      const mine = await ownWorkspace();
      const redirect = await approved(await authorizeUrl(await startAs(admin, {}, mine)));
      for (let i = 0; i < revokedAnswers; i++) sim.faults.failNext("GET /v1/account", revoked);
      const looks = inspectCalls();
      const done = outcomeOf(await callbackAs(admin, redirect));
      expect(done.channel).not.toBeNull();
      expect(inspectCalls()).toBe(looks + 2);
      const sql = "SELECT health FROM app.channels WHERE id = $1";
      expect((await q<{ health: string }>(sql, [done.channel]))[0]?.health).toBe(health);
    },
    60_000,
  );

  it("a health look that fails to answer still ends as connected; the next check records the health", async () => {
    const mine = await ownWorkspace();
    const redirect = await approved(await authorizeUrl(await startAs(admin, {}, mine)));
    for (let i = 0; i < 2; i++) sim.faults.failNext("GET /v1/account", { kind: "truncate" });
    const done = outcomeOf(await callbackAs(admin, redirect));
    expect(done).toMatchObject({ status: 302, reason: null });
    expect(done.channel).not.toBeNull();
    expect(await countOf("channels", mine)).toBe(1);
  }, 60_000);
});

describe("the per-user buckets of start and callback", () => {
  it("start: the 11th start of a user answers 429 with Retry-After and a second user is unaffected", async () => {
    const [first, second] = [
      await signedUser(fx, "connect-bucket-a"),
      await signedUser(fx, "connect-bucket-b"),
    ];
    for (const who of [first, second]) await addWorkspaceMember(fx, workspace, who.id, "admin");
    for (let i = 0; i < 10; i++) expect((await rawStartAs(first)).status).toBe(200);
    const refused = await rawStartAs(first);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await rawStartAs(second)).status).toBe(200);
  }, 120_000);

  it("callback: the 21st callback of a user, unknown states included, answers rate_limited and a second user is unaffected", async () => {
    const [first, second] = [
      await signedUser(fx, "connect-bucket-c"),
      await signedUser(fx, "connect-bucket-d"),
    ];
    for (let i = 0; i < 20; i++) {
      expect(outcomeOf(await rawCallbackAs(first, unknownState())).reason).toBe("refused");
    }
    const limited = await rawCallbackAs(first, unknownState());
    expect(outcomeOf(limited)).toMatchObject({ status: 302, reason: "rate_limited", keys: ["reason"] });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(outcomeOf(await rawCallbackAs(second, unknownState())).reason).toBe("refused");
  }, 120_000);

  it("a callback with no session spends no bucket, where one with a session spends exactly one", async () => {
    const buckets = async () =>
      (await q("SELECT 1 FROM app.rate_buckets WHERE scope = 'connect_callback'")).length;
    const before = await buckets();
    await rawCallbackAs(await signedUser(fx, "connect-bucket-e"), unknownState());
    expect(await buckets()).toBe(before + 1);
    await rawCallbackAs(undefined, unknownState());
    expect(await buckets()).toBe(before + 1);
  }, 60_000);
});

describe("secrets stay out of everything that is shown or logged", () => {
  it("the verifier, state and tokens are in no log, audit row, redirect URL or flow row", async () => {
    const mine = await ownWorkspace();
    const url = await authorizeUrl(await startAs(admin, {}, mine));
    const state = new URL(url).searchParams.get("state") ?? "";
    const done = await callbackAs(admin, await approved(url));
    const channel = outcomeOf(done).channel ?? "";
    const exchange = exchangeCalls().at(-1);
    const credentials = createCredentialService({
      pool: fx.db.pool("worker"),
      keys,
      pepper: new SealedSecret(PEPPER),
      fetch,
      now: () => new Date(),
      logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
      providers: { [FIRST]: { adapter: adapter(), manifest: manifestOf(FIRST) } },
    });
    const tokens = await credentials.open(mine, channel);
    // A failed connect writes a log line too: its verifier and state must stay out of it.
    const mismatched = challengeOf("a-canary-verifier-that-is-long-enough-1234567890abcd");
    const failing = await begin(admin, {}, (query) => query.set("code_challenge", mismatched));
    expect(outcomeOf(await callbackAs(admin, failing.redirect)).reason).toBe("failed");
    const secrets = [
      new URLSearchParams(exchange?.body.toString("utf8")).get("code_verifier") ?? "",
      state,
      tokens.accessToken.expose(),
      tokens.refreshToken?.expose() ?? "",
      await verifierOf(failing.state),
      failing.state,
    ];
    expect(secrets.every((secret) => secret.length >= 8)).toBe(true);
    const audit = await q("SELECT row_to_json(l)::text AS t FROM app.audit_logs l");
    const flows = await q("SELECT row_to_json(f)::text AS t FROM app.oauth_flows f");
    const haystack = [
      fx.logged.join("\n"),
      JSON.stringify(audit),
      JSON.stringify(flows),
      done.headers.get("location") ?? "",
    ];
    expect(leaks(haystack.join("\n"), secrets)).toEqual([]);
  }, 60_000);
});
