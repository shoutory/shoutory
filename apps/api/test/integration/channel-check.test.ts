import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { startFixtureOAuthSimulator } from "@shoutory/testkit/fixture-oauth/simulator";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialService } from "../../src/channels/credentials.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import { FAKE_CLIENT, mintTokens } from "../support/oauth-fake.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, keys, PEPPER, startFixture } from "./auth/harness.js";

// "Check now" (R532 (13)-(15), R542): one on-demand read of a channel's provider with its sealed access token, stored
// with its check time. A failed read never disconnects, a denied caller never causes a provider call, and the token
// never leaves the sealed store. Every provider answer is real HTTP to the fixture OAuth network on loopback.
type User = { id: string; cookie: string };
const manifest = manifestSchema.parse(fixtureOAuthManifest);
let fx: Fixture;
let sim: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
let workspace: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
const adapter = () => createFixtureAdapter({ baseUrl: sim.url, clientId: FAKE_CLIENT });

beforeAll(async () => {
  sim = await startFixtureOAuthSimulator({ now: () => new Date() });
  fx = await startFixture({
    channels: {
      providers: { fixture_oauth: { adapter: adapter(), manifest } },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "check-org");
  workspace = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `check-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, workspace, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await sim.close();
  await fx.close();
});

const inspects = () => sim.requests.filter((r) => r.method === "GET" && r.path === "/v1/account");
const inspectCalls = () => inspects().length;
const tokenCalls = () => sim.requests.filter((r) => r.method === "POST" && r.path === "/token").length;
const path = (ws: string, channel: string) => `/api/v1/workspaces/${ws}/channels/${channel}`;
const check = (who: User, ws: string, channel: string) =>
  fx.request(`${path(ws, channel)}/check`, { method: "POST", headers: { cookie: who.cookie } });
const detail = (who: User, ws: string, channel: string) =>
  fx.request(path(ws, channel), { headers: { cookie: who.cookie } });
const rowOf = (channel: string) =>
  fx.admin(
    async (c) =>
      (
        await c.query(
          "SELECT connection_state, health, health_checked_at, capability_epoch FROM app.channels WHERE id = $1",
          [channel],
        )
      ).rows[0],
  );
const snapshotCount = (channel: string) =>
  fx.admin(
    async (c) =>
      (
        await c.query(
          "SELECT count(*)::int AS n FROM app.channel_capability_snapshots WHERE channel_id = $1",
          [channel],
        )
      ).rows[0].n as number,
  );
// Lets the next check through: the cooldown reads `health_checked_at`.
const backdate = (channel: string) =>
  fx.admin((c) =>
    c.query(
      "UPDATE app.channels SET health_checked_at = health_checked_at - interval '61 seconds' WHERE id = $1",
      [channel],
    ),
  );

interface Made {
  channelId: string;
  access: string;
  refresh: string | undefined;
}
// A connected channel holding tokens the fake issued; `due` makes its access token already expired.
async function channelWith(
  options: { due?: boolean; refresh?: boolean; state?: string } = {},
): Promise<Made> {
  const minted = await mintTokens(sim.url);
  const credentials = createCredentialService({
    pool: fx.db.pool("worker"),
    keys,
    pepper: new SealedSecret(PEPPER),
    fetch,
    now: () => new Date(),
    logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
    providers: { fixture_oauth: { adapter: adapter(), manifest } },
  });
  const withRefresh = options.refresh !== false;
  const made = await credentials.connect({
    principal: { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspace] },
    workspaceId: workspace,
    identity: {
      providerId: "fixture_oauth",
      accountKind: "profile",
      providerAccountId: randomUUID(),
      displayName: "Check channel",
    },
    tokens: {
      access_token: minted.access_token,
      ...(withRefresh ? { refresh_token: minted.refresh_token } : {}),
    },
    accessExpiresAt: new Date(Date.now() + (options.due ? -1000 : 3_600_000)),
    snapshot: snapshotOf(manifest, new Date()),
    audit: { requestId: "req-connect", ipHmac: null },
  });
  if (options.state) {
    await fx.admin((c) =>
      c.query("UPDATE app.channels SET connection_state = $2 WHERE id = $1", [made.channelId, options.state]),
    );
  }
  return {
    channelId: made.channelId,
    access: minted.access_token,
    refresh: withRefresh ? minted.refresh_token : undefined,
  };
}
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string } };
  return [answer.status, error.code];
};

describe("who may check a channel (channels.manage)", () => {
  it.each([
    ["owner", 200],
    ["admin", 200],
    ["editor", 403],
    ["approver", 403],
    ["viewer", 403],
    ["outsider", 404],
    ["foreign", 404],
  ])("a %s gets %i, and a denied caller causes no provider call", async (who, status) => {
    const { channelId } = await channelWith();
    const before = inspectCalls();
    const answer = await check(user(who), workspace, channelId);
    expect(answer.status).toBe(status);
    expect(inspectCalls() - before).toBe(status === 200 ? 1 : 0);
  });

  it("a channel of another workspace answers 404 like a missing one, with no provider call", async () => {
    const { channelId } = await channelWith();
    const before = inspectCalls();
    const viaOther = await check(user("foreign"), other, channelId);
    const missing = await check(user("admin"), workspace, "019a0000-0000-7000-8000-000000000000");
    expect([viaOther.status, missing.status]).toEqual([404, 404]);
    expect(await errorOf(viaOther)).toEqual(await errorOf(missing));
    expect(inspectCalls()).toBe(before);
  });
});

describe("the answer of a check", () => {
  it("carries exactly the channel allowlist and a check time, and shows the access token nowhere", async () => {
    const { channelId, access, refresh } = await channelWith();
    const answer = await check(user("admin"), workspace, channelId);
    const text = await answer.text();
    const body = JSON.parse(text) as { data: Record<string, unknown> };
    const shown = JSON.parse(await (await detail(user("admin"), workspace, channelId)).text()) as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(body.data).sort()).toEqual(Object.keys(shown.data).sort());
    expect(body.data).toMatchObject({ id: channelId, health: "ok", connection_state: "connected" });
    expect(body.data.health_checked_at).toEqual(expect.any(String));
    // AGENTS 4.2: neither token is in the body or in any log line of the app, in any of the six spellings.
    expect(leaks(`${text}\n${fx.logged.join("\n")}`, [access, ...(refresh ? [refresh] : [])])).toEqual([]);
  });

  it("the provider receives the access token that was stored", async () => {
    const { channelId, access } = await channelWith();
    await check(user("admin"), workspace, channelId);
    expect(inspects().at(-1)?.headers.authorization).toBe(`Bearer ${access}`);
  });
});

describe("the cooldown", () => {
  it("a second check within 60 seconds is a 429 with a Retry-After and no provider call, and passes once it is past", async () => {
    const { channelId } = await channelWith();
    expect((await check(user("admin"), workspace, channelId)).status).toBe(200);
    const before = inspectCalls();
    const again = await check(user("admin"), workspace, channelId);
    expect(await errorOf(again.clone())).toEqual([429, "too_many_requests"]);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(again.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(inspectCalls()).toBe(before);
    await backdate(channelId);
    expect((await check(user("admin"), workspace, channelId)).status).toBe(200);
  });
});

describe("what a check does to the channel", () => {
  const respond = (status: number, body?: unknown) => ({
    kind: "respond" as const,
    status,
    ...(body === undefined ? {} : { body }),
  });
  // [what the provider answered at the account route, the health the check records]
  const READS: [string, ReturnType<typeof respond> | undefined, string][] = [
    ["an ok answer", undefined, "ok"],
    ["a 429", respond(429), "degraded"],
    ["a 503", respond(503), "degraded"],
    ["a 200 that is not an account", respond(200, "garbled"), "degraded"],
    ["a 401 with no code", respond(401), "failing"],
    ["a 400 refusal", respond(400, { error: { code: "bad_request" } }), "failing"],
    ["a revoked grant", respond(401, { error: { code: "grant_revoked" } }), "failing"],
  ];
  it.each(READS)("%s records %s and leaves the connection state alone", async (_name, fault, health) => {
    const { channelId, access } = await channelWith();
    if (fault) sim.faults.failNext("GET /v1/account", fault);
    const answer = await check(user("admin"), workspace, channelId);
    const text = await answer.text();
    expect(answer.status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({ health, connection_state: "connected" });
    expect(await rowOf(channelId)).toMatchObject({ connection_state: "connected", health });
    expect(leaks(`${text}\n${fx.logged.join("\n")}`, [access])).toEqual([]);
  });

  it.each(["disabled", "needs_reconnect", "disconnected"])(
    "a %s channel answers 409 and makes no provider call",
    async (state) => {
      const { channelId } = await channelWith({ state });
      const before = inspectCalls();
      expect(await errorOf(await check(user("admin"), workspace, channelId))).toEqual([409, "conflict"]);
      expect(inspectCalls()).toBe(before);
      expect((await rowOf(channelId)).health).toBeNull();
    },
  );
});

describe("a check of a channel whose access token is due (R542 (5))", () => {
  const refused = (status: number, error: string) => ({ kind: "respond" as const, status, body: { error } });
  // [the setup, what the token route answers, the health, the state, whether the provider is read at all]
  // The state is asserted where the check itself leaves it connected; a revocation's move to needs_reconnect is the
  // refresh service's own behaviour, tested in credential-refresh (R543 (4)), so that row names no state.
  const DUE: [
    string,
    { refresh?: boolean },
    ReturnType<typeof refused> | undefined,
    string,
    string | undefined,
    boolean,
  ][] = [
    ["a refresh that succeeds", {}, undefined, "ok", "connected", true],
    ["a refresh retried later (a 503)", {}, refused(503, "unavailable"), "degraded", "connected", false],
    [
      "a refresh that revokes (invalid_grant)",
      {},
      refused(400, "invalid_grant"),
      "failing",
      undefined,
      false,
    ],
    [
      "a refresh the manifest does not map",
      {},
      refused(400, "a_code_nobody_mapped"),
      "failing",
      "connected",
      false,
    ],
    ["a credential with no refresh token", { refresh: false }, undefined, "failing", "connected", false],
  ];
  it.each(DUE)("%s", async (_name, setup, tokenFault, health, state, read) => {
    const { channelId, access } = await channelWith({ due: true, ...setup });
    if (tokenFault) sim.faults.failNext("POST /token", tokenFault);
    const reads = inspectCalls();
    const tokens = tokenCalls();
    const answer = await check(user("admin"), workspace, channelId);
    expect(answer.status).toBe(200);
    expect(await rowOf(channelId)).toMatchObject({ ...(state ? { connection_state: state } : {}), health });
    expect(inspectCalls() - reads).toBe(read ? 1 : 0);
    if (setup.refresh === false) expect(tokenCalls()).toBe(tokens);
    // After a refresh the provider is read with the new token, never with the one that had expired.
    if (read) expect(inspects().at(-1)?.headers.authorization).not.toBe(`Bearer ${access}`);
  });
});

describe("the snapshot a check records", () => {
  it("adds an epoch only when the capability answer changed", async () => {
    const { channelId } = await channelWith();
    await check(user("admin"), workspace, channelId);
    expect(await rowOf(channelId)).toMatchObject({ capability_epoch: 1 });
    expect(await snapshotCount(channelId)).toBe(1);
    await backdate(channelId);
    await fx.admin((c) =>
      c.query(
        "UPDATE app.channel_capability_snapshots SET manifest_digest = 'an-older-manifest' WHERE channel_id = $1",
        [channelId],
      ),
    );
    await check(user("admin"), workspace, channelId);
    expect(await rowOf(channelId)).toMatchObject({ capability_epoch: 2 });
    expect(await snapshotCount(channelId)).toBe(2);
  });
});
