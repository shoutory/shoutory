import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { SealedSecret } from "@shoutory/core/crypto";
import type { TenantCtx } from "@shoutory/db/context";
import { withAdvisoryLock } from "@shoutory/db/locks";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { startFixtureOAuthSimulator } from "@shoutory/testkit/fixture-oauth/simulator";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCredentialService } from "../../src/channels/credentials.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import { FAKE_CLIENT as CLIENT, mintTokens } from "../support/oauth-fake.js";
import { seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, keys, PEPPER, startFixture } from "./auth/harness.js";

let fx: Fixture;
let sim: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
let workspace: string;
const logged: string[] = [];

const service = (egress: typeof fetch = fetch) =>
  createCredentialService({
    pool: fx.db.pool("worker"),
    keys,
    pepper: new SealedSecret(PEPPER),
    fetch: egress,
    now: () => new Date(),
    logger: createLogger({ secrets: [], stream: { write: (line: string) => void logged.push(line) } }),
    providerTimeoutMs: 400,
    providers: {
      fixture_oauth: {
        adapter: createFixtureAdapter({ baseUrl: sim.url, clientId: CLIENT }),
        manifest: { refreshErrorMap: fixtureOAuthManifest.refreshErrorMap },
      },
    },
  });
const principal = (): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: [workspace],
});

const mint = () => mintTokens(sim.url);

async function connected(tokens?: {
  access_token: string;
  refresh_token?: string;
}): Promise<{ channelId: string; minted: { access_token: string; refresh_token?: string } }> {
  const minted = tokens ?? (await mint());
  const made = await service().connect({
    principal: principal(),
    workspaceId: workspace,
    identity: {
      providerId: "fixture_oauth",
      accountKind: "profile",
      providerAccountId: randomUUID(),
      displayName: "Fixture account",
    },
    tokens: {
      access_token: minted.access_token,
      ...(minted.refresh_token === undefined ? {} : { refresh_token: minted.refresh_token }),
    },
    accessExpiresAt: new Date(Date.now() - 1000),
    snapshot: {
      manifestDigest: "digest-a",
      apiVersion: "v1",
      sunsetAt: null,
      capabilities: { text: true },
      limits: { text: 280 },
    },
    audit: { requestId: "req-connect", ipHmac: null },
  });
  return { channelId: made.channelId, minted };
}
const stateOf = async (channelId: string) =>
  fx.admin(
    async (c) =>
      (await c.query("SELECT connection_state, state_reason FROM app.channels WHERE id = $1", [channelId]))
        .rows[0],
  );
const markerOf = async (channelId: string) =>
  fx.admin(
    async (c) =>
      (
        await c.query(
          "SELECT generation, refresh_attempt_outcome FROM app.channel_credentials WHERE channel_id = $1",
          [channelId],
        )
      ).rows[0],
  );
const tokenCalls = () => sim.requests.filter((r) => r.method === "POST" && r.path === "/token").length;

beforeAll(async () => {
  fx = await startFixture();
  const owner = await signedUser(fx, "cred-owner");
  workspace = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
  sim = await startFixtureOAuthSimulator({ now: () => new Date() });
});
afterAll(async () => {
  await sim.close();
  await fx.close();
});
beforeEach(() => {
  logged.length = 0;
});

describe("a refresh that succeeds", () => {
  it("stores the rotated tokens as the next generation; the spent refresh token is gone", async () => {
    const { channelId, minted } = await connected();
    expect(await service().refresh(workspace, channelId)).toEqual({ kind: "refreshed", generation: 2 });
    const opened = await service().open(workspace, channelId);
    expect(opened.generation).toBe(2);
    expect(opened.accessToken.expose()).not.toBe(minted.access_token);
    expect(opened.refreshToken?.expose()).not.toBe(minted.refresh_token);
  });
});

describe("the lease", () => {
  it("a refresher that finds the lease held does not call the provider and reports the lost race", async () => {
    const { channelId } = await connected();
    await fx.admin((c) =>
      c.query(
        "UPDATE app.channel_credentials SET refreshing_until = clock_timestamp() + interval '60 seconds', refresh_owner = 'other', refresh_fencing = 5 WHERE channel_id = $1",
        [channelId],
      ),
    );
    const before = tokenCalls();
    expect(await service().refresh(workspace, channelId)).toEqual({ kind: "lost_race" });
    expect(tokenCalls()).toBe(before);
  });

  // The injected fetch lets a competing refresh commit before it answers invalid_grant, as a provider that rotated
  // the token for the competitor would.
  it("an invalid_grant that follows a competing commit keeps the state and the next open returns the new token", async () => {
    const { channelId, minted } = await connected();
    const racing: typeof fetch = async (input, init) => {
      if (!String(input).endsWith("/token")) return fetch(input, init);
      await fx.admin((c) =>
        c.query(
          "UPDATE app.channel_credentials SET refreshing_until = clock_timestamp() - interval '1 second' WHERE channel_id = $1",
          [channelId],
        ),
      );
      expect(await service().refresh(workspace, channelId)).toMatchObject({
        kind: "refreshed",
        generation: 2,
      });
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    expect(await service(racing).refresh(workspace, channelId)).toEqual({ kind: "lost_race" });
    expect(await stateOf(channelId)).toEqual({ connection_state: "connected", state_reason: null });
    const opened = await service().open(workspace, channelId);
    expect(opened.generation).toBe(2);
    expect(opened.refreshToken?.expose()).not.toBe(minted.refresh_token);
  });
});

const FAULT = (status: number, error?: string, headers: Record<string, string> = {}) => ({
  kind: "respond" as const,
  status,
  headers,
  ...(error ? { body: { error } } : {}),
});
// [what the provider answered, the outcome, the channel state afterwards]
type Answer = { kind: "respond"; status: number; headers?: Record<string, string>; body?: unknown };
const CLASSES: [string, Answer, object, string, string | null][] = [
  ["a 503", FAULT(503), { kind: "retry_later", refreshClass: "transient" }, "connected", null],
  // A 2xx answer that cannot be used may have spent the token: unknown, never a config or a revocation.
  [
    "a 200 answer the adapter cannot use",
    { kind: "respond", status: 200, body: { access_token: "a-token-without-lifetime" } },
    { kind: "retry_later", refreshClass: "transient" },
    "connected",
    null,
  ],
  [
    "a 200 answer whose lifetime is out of bound",
    { kind: "respond", status: 200, body: { access_token: "a-token-of-any-kind", expires_in: 31_536_001 } },
    { kind: "retry_later", refreshClass: "transient" },
    "connected",
    null,
  ],
  [
    "a 429",
    FAULT(429, undefined, { "retry-after": "3" }),
    { kind: "retry_later", refreshClass: "rate_limited" },
    "connected",
    null,
  ],
  [
    "a mapped rate-limit code",
    FAULT(400, "slow_down"),
    { kind: "retry_later", refreshClass: "rate_limited" },
    "connected",
    null,
  ],
  [
    "a mapped transient code",
    FAULT(400, "temporarily_unavailable"),
    { kind: "retry_later", refreshClass: "transient" },
    "connected",
    null,
  ],
  ["a mapped operator error", FAULT(400, "invalid_client"), { kind: "config" }, "connected", null],
  [
    "a code the manifest does not map",
    FAULT(400, "a_code_nobody_mapped"),
    { kind: "config" },
    "connected",
    null,
  ],
  [
    "a first invalid_grant",
    FAULT(400, "invalid_grant"),
    { kind: "needs_reconnect", reason: "revoked_confirmed" },
    "needs_reconnect",
    "revoked_confirmed",
  ],
];

describe("what each failure does to the channel", () => {
  it.each(CLASSES)("%s", async (_name, fault, outcome, state, reason) => {
    const { channelId, minted } = await connected();
    sim.faults.failNext("POST /token", fault);
    expect(await service().refresh(workspace, channelId)).toEqual(outcome);
    expect(await stateOf(channelId)).toEqual({ connection_state: state, state_reason: reason });
    const opened = await service().open(workspace, channelId);
    expect([opened.generation, opened.accessToken.expose(), opened.refreshToken?.expose()]).toEqual([
      1,
      minted.access_token,
      minted.refresh_token,
    ]);
  });

  it("a credential with no refresh token is not refreshed: no provider call, no state change, no marker", async () => {
    const { channelId } = await connected({ access_token: "access-token-without-refresh" });
    const before = tokenCalls();
    expect(await service().refresh(workspace, channelId)).toEqual({ kind: "no_refresh_token" });
    expect(tokenCalls()).toBe(before);
    expect(await stateOf(channelId)).toEqual({ connection_state: "connected", state_reason: null });
    expect((await markerOf(channelId)).refresh_attempt_outcome).toBeNull();
  });

  it("a timeout leaves the channel connected and the attempt unknown", async () => {
    const { channelId } = await connected();
    sim.faults.failNext("POST /token", { kind: "hang" });
    expect(await service().refresh(workspace, channelId)).toEqual({
      kind: "retry_later",
      refreshClass: "transient",
    });
    expect(await stateOf(channelId)).toEqual({ connection_state: "connected", state_reason: null });
    expect((await markerOf(channelId)).refresh_attempt_outcome).toBe("unknown");
  });
});

describe("an attempt that may have spent the token", () => {
  // An attempt whose answer was lost or unusable may have spent a rotating token: it stays unknown, so the
  // invalid_grant that follows is not a confirmed revocation.
  it.each([
    [
      "a 503 after the provider spent the token",
      { kind: "respond" as const, status: 503, afterEffect: true },
    ],
    [
      "a 200 answer that cannot be used",
      { kind: "respond" as const, status: 200, body: { access_token: "a-token-without-lifetime" } },
    ],
  ])("%s, then invalid_grant, is refresh_token_rotated_unknown", async (_name, first) => {
    const { channelId } = await connected();
    sim.faults.failNext("POST /token", first);
    expect(await service().refresh(workspace, channelId)).toEqual({
      kind: "retry_later",
      refreshClass: "transient",
    });
    sim.faults.failNext("POST /token", FAULT(400, "invalid_grant"));
    expect(await service().refresh(workspace, channelId)).toEqual({
      kind: "needs_reconnect",
      reason: "refresh_token_rotated_unknown",
    });
    expect(await stateOf(channelId)).toEqual({
      connection_state: "needs_reconnect",
      state_reason: "refresh_token_rotated_unknown",
    });
  });
});

const databaseDump = () =>
  fx.admin(async (c) => {
    const tables = await c.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('app', 'auth')",
    );
    const out: string[] = [];
    for (const { schemaname, tablename } of tables.rows) {
      const found = await c.query(`SELECT t::text AS row FROM "${schemaname}"."${tablename}" AS t`);
      out.push(...found.rows.map((r) => r.row as string));
    }
    return out.join("\n");
  });

describe("no token leaves the sealed store", () => {
  it("holds for a connected, refreshed, failed and adapter-called channel", async () => {
    const { channelId, minted } = await connected();
    await service().refresh(workspace, channelId);
    const opened = await service().open(workspace, channelId);
    sim.faults.failNext("POST /token", {
      kind: "respond",
      status: 400,
      body: { error: "unmapped_code_value_7" },
    });
    const failure = await service().refresh(workspace, channelId);
    const other = await mint();
    const adapter = createFixtureAdapter({ baseUrl: sim.url, clientId: CLIENT });
    const result = await adapter.refresh?.(
      { fetch, now: () => new Date() },
      { refreshToken: new SealedSecret(other.refresh_token) },
    );
    const secrets = [
      minted.access_token,
      minted.refresh_token ?? "",
      opened.accessToken.expose(),
      opened.refreshToken?.expose() ?? "",
      other.refresh_token,
      result?.credential?.accessToken.expose() ?? "",
      result?.credential?.refreshToken?.expose() ?? "",
    ];
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);
    expect(leaks(await databaseDump(), secrets)).toEqual([]);
    expect(leaks(logged.join("\n"), secrets)).toEqual([]);
    expect(
      leaks(
        [JSON.stringify(failure), JSON.stringify(result), inspect(result, { depth: 8 })].join("\n"),
        secrets,
      ),
    ).toEqual([]);
    expect(logged.join("\n")).not.toContain("unmapped_code_value_7");
    expect(logged.length).toBeGreaterThan(0);
  });
});

// A reconnect of a channel takes the channel's advisory lock, so two reconnects of one channel are ordered; a first
// connect has no channel to lock and relies on the identity key.
describe("a reconnect", () => {
  const waitsOnAdvisoryLock = async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await fx.admin((c) =>
        c.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"),
      );
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the reconnect never waited for the channel's lock");
  };

  it("takes the channel's advisory lock: it waits for another holder, then lands the next generation", async () => {
    const account = randomUUID();
    const connectWith = (reconnectChannelId?: string) =>
      service().connect({
        principal: principal(),
        workspaceId: workspace,
        identity: {
          providerId: "fixture_oauth",
          accountKind: "profile",
          providerAccountId: account,
          displayName: "Fixture account",
        },
        ...(reconnectChannelId === undefined ? {} : { reconnectChannelId }),
        tokens: { access_token: `reconnect-token-${randomUUID()}` },
        accessExpiresAt: new Date(Date.now() + 3_600_000),
        snapshot: {
          manifestDigest: "digest-a",
          apiVersion: "v1",
          sunsetAt: null,
          capabilities: { text: true },
          limits: { text: 280 },
        },
        audit: { requestId: "req-reconnect", ipHmac: null },
      });
    const first = await connectWith();
    const holder = await fx.db.pool("worker").connect();
    try {
      await holder.query("BEGIN");
      await withAdvisoryLock(holder, "channel", async () => undefined, first.channelId);
      const pending = connectWith(first.channelId);
      await waitsOnAdvisoryLock();
      await holder.query("COMMIT");
      expect(await pending).toEqual({ channelId: first.channelId, generation: 2 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);
});
