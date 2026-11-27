import { type Aad, EnvelopeError, FORMAT_VERSION, open, SealedSecret } from "@shoutory/core/crypto";
import { createAppPool } from "@shoutory/db/pool";
import type {
  AuthorizeInput,
  ConnectAdapter,
  ExchangeInput,
  ProviderAdapter,
} from "@shoutory/provider-sdk/adapter";
import { type Manifest, manifestSchema } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChallengePoll } from "../../src/jobs/connect-challenge.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, keys, ORIGIN, PEPPER, startFixture } from "./auth/harness.js";

// Two fake providers stand in for a bot token and a webhook URL; their adapters only answer what the base asks of an
// adapter, so these rows test the shared connect code and not any provider.
const BOT = "fixture_bot";
const HOOK = "fixture_hook";
const OAUTH = "fixture_issuer";
const ISSUER = "https://issuer.example.test";
const BOT_HOST = "bots.example.test";
const HOOK_HOST = "hooks.example.test";

const manifestOf = (id: string, method: Manifest["auth"]["method"], host: string): Manifest =>
  manifestSchema.parse({ ...fixtureManifest, id, displayName: id, auth: { method }, egressHosts: [host] });
const permanent: ProviderResult = { ok: false, effect: "none", errorClass: "permanent" };
const base = {
  prepare: async () => permanent,
  commit: async () => permanent,
  readBack: async () => permanent,
  delete: async () => permanent,
  inspect: async () => ({ ok: true, effect: "none" }) as ProviderResult,
} satisfies Omit<ProviderAdapter, "connect">;

const queue: { text: string; chatId: string; title: string }[] = [];
const pollCalls: number[] = [];
const verified: string[] = [];
const identityOf = (id: string): ProviderResult => ({
  ok: true,
  effect: "none",
  identity: { providerAccountId: id, accountKind: "bot", displayName: "Fixture account" },
});
const botConnect: ConnectAdapter = {
  authorize: async () => {
    throw new Error("a bot token has no authorize step");
  },
  exchangeCode: async () => permanent,
  identity: async () => permanent,
  verifySecret: async (_context, input) => {
    verified.push(input.secret.expose());
    return identityOf(`bot-of-${input.secret.expose().split(":")[0]}`);
  },
  pollChallenge: async (_context, input) => {
    pollCalls.push(input.offset);
    if (input.botToken.expose().startsWith("unreadable-")) throw new Error("the bot could not be read");
    if (input.botToken.expose().startsWith("badoffset-")) {
      return { ok: true, effect: "none", poll: { nextOffset: -1, messages: [] } };
    }
    const messages = queue.splice(0);
    return { ok: true, effect: "none", poll: { nextOffset: input.offset + messages.length + 1, messages } };
  },
};
const hookConnect: ConnectAdapter = {
  ...botConnect,
  verifySecret: async (_context, input) => {
    verified.push(input.secret.expose());
    return identityOf("hook-account-1");
  },
};

const DPOP_JWK = { kty: "EC", crv: "P-256", x: "x-1", y: "y-1", d: "dpop-private-1" };
let issuerExchanges = 0;
let flowsWhenAuthorized = -1;
let grants = false;
let lastExchange: ExchangeInput | undefined;
let lastAuthorize: AuthorizeInput | undefined;
let appsMade = 0;
const oauthConnect: ConnectAdapter = {
  appKind: "provider",
  registerApp: async () => {
    appsMade += 1;
    return {
      ok: true,
      effect: "none",
      app: { clientId: "provider-client-1", clientSecret: new SealedSecret("provider-app-secret-1") },
    };
  },
  authorize: async (_context, input) => {
    flowsWhenAuthorized = await countFlows();
    lastAuthorize = input;
    return {
      url: `https://issuer.example.test/authorize?${new URLSearchParams({ state: input.state })}`,
      issuer: ISSUER,
      requestUri: "urn:ietf:params:oauth:request_uri:par-1",
      dpopKey: new SealedSecret(JSON.stringify(DPOP_JWK)),
    };
  },
  exchangeCode: async (_context, input) => {
    issuerExchanges += 1;
    lastExchange = input;
    if (!grants) return permanent;
    return {
      ok: true,
      effect: "none",
      credential: { accessToken: new SealedSecret("par-access-1"), dpopPrivateJwk: DPOP_JWK, issuer: ISSUER },
    };
  },
  identity: async () => identityOf("par-account-1"),
};

const providers = {
  [BOT]: { manifest: manifestOf(BOT, "bot_token", BOT_HOST), adapter: { ...base, connect: botConnect } },
  [HOOK]: {
    manifest: manifestOf(HOOK, "webhook_url", HOOK_HOST),
    adapter: { ...base, connect: hookConnect },
  },
  [OAUTH]: {
    manifest: manifestOf(OAUTH, "oauth2_pkce", "issuer.example.test"),
    adapter: { ...base, connect: oauthConnect },
  },
};

let fx: Fixture;
let workspace: string;
let admin: { id: string; cookie: string };
const countFlows = async () =>
  Number(
    (await fx.admin((c) => c.query("SELECT count(*) AS n FROM app.oauth_flows"))).rows[0]?.n ?? Number.NaN,
  );
const q = <T>(sql: string, params: unknown[] = []) =>
  fx.admin(async (c) => (await c.query(sql, params)).rows as T[]);
const answers: string[] = [];

beforeAll(async () => {
  fx = await startFixture({
    channels: { providers, fetch, pepper: new SealedSecret(PEPPER) },
    secrets: [],
  });
  const founder = await signedUser(fx, "secrets-founder");
  const org = await seedOrganization(fx, founder.id);
  workspace = await seedWorkspace(fx, org);
  admin = await signedUser(fx, "secrets-admin");
  await addWorkspaceMember(fx, workspace, admin.id, "admin");
}, 90_000);
afterAll(() => fx.close());

const refill = (scope: "connect_start" | "connect_callback") =>
  q("DELETE FROM app.rate_buckets WHERE scope = $1 AND key = $2", [
    scope,
    fx.auth.bucketKey(scope, admin.id),
  ]);
async function post(path: string, body?: object): Promise<Response> {
  await refill("connect_start");
  await refill("connect_callback");
  const answer = await fx.request(`/api/v1/workspaces/${workspace}/connect/${path}`, {
    method: "POST",
    headers: { cookie: admin.cookie },
    ...(body === undefined ? {} : { body }),
  });
  answers.push(await answer.clone().text());
  return answer;
}
const dataOf = async <T>(answer: Response) => ((await answer.json()) as { data: T }).data;

function runPoll() {
  const pool = createAppPool(fx.db.url("worker"), () => undefined);
  const logger = createLogger({ secrets: [], stream: { write: (line) => void fx.logged.push(line) } });
  return runChallengePoll({
    pool,
    keys,
    providers,
    fetchFor: () => fetch,
    now: () => new Date(),
    logger,
  }).finally(() => pool.end());
}

const aadOf = (scopeId: string, ownerId: string, credentialKind: Aad["credentialKind"]): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId,
  ownerId,
  credentialKind,
  generation: 1,
});
interface SealedRow {
  format_version: number | null;
  key_id: string | null;
  iv: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  wrap_iv: Buffer | null;
  wrap_tag: Buffer | null;
  wrapped_dek: Buffer | null;
}
const SEALED = "format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek";
const storedOf = (row: SealedRow) => ({
  formatVersion: Number(row.format_version),
  keyId: String(row.key_id),
  iv: row.iv as Buffer,
  ciphertext: row.ciphertext as Buffer,
  tag: row.auth_tag as Buffer,
  wrapIv: row.wrap_iv as Buffer,
  wrapTag: row.wrap_tag as Buffer,
  wrappedDek: row.wrapped_dek as Buffer,
});
const saltOf = async () =>
  (
    await q<{ salt: Buffer }>("SELECT salt FROM app.workspace_key_salts WHERE workspace_id = $1", [workspace])
  )[0]?.salt;

describe("the poll of the bots' updates", () => {
  it("one unreadable row never stops the other bots, and its error is logged by class only", async () => {
    const bad = await post(`${BOT}/secret`, { secret: "unreadable-1:secret-bad-value" });
    const good = await post(`${BOT}/secret`, { secret: "readable-2:secret-good-value" });
    const { challenge_id: goodId, word } = await dataOf<{ challenge_id: string; word: string }>(good);
    expect(bad.status).toBe(200);
    queue.push({ text: `/connect ${word}`, chatId: "-1003", title: "Readable chat" });
    await runPoll();
    const status = await fx.request(`/api/v1/workspaces/${workspace}/connect/${BOT}/challenge/${goodId}`, {
      headers: { cookie: admin.cookie },
    });
    expect(await dataOf(status)).toMatchObject({ state: "matched", chat_title: "Readable chat" });
    const logs = fx.logged.join("\n");
    expect(logs).toContain("connect_challenge_poll_failed");
    expect(logs).not.toContain("secret-bad-value");
  });
});

describe("a database error in the poll", () => {
  it("is not swallowed: the other bots are finished, then the job fails", async () => {
    const bad = await post(`${BOT}/secret`, { secret: "badoffset-4:secret-offset-value" });
    const good = await post(`${BOT}/secret`, { secret: "readable-5:secret-good-value" });
    const { challenge_id: badId } = await dataOf<{ challenge_id: string }>(bad);
    const { challenge_id: goodId, word } = await dataOf<{ challenge_id: string; word: string }>(good);
    queue.push({ text: `/connect ${word}`, chatId: "-1004", title: "Finished chat" });
    try {
      await expect(runPoll()).rejects.toMatchObject({ code: "22023" });
      const status = await fx.request(`/api/v1/workspaces/${workspace}/connect/${BOT}/challenge/${goodId}`, {
        headers: { cookie: admin.cookie },
      });
      expect(await dataOf(status)).toMatchObject({ state: "matched", chat_title: "Finished chat" });
    } finally {
      await q("UPDATE app.connect_challenges SET consumed_at = now() WHERE id = $1", [badId]);
    }
  });
});

describe("a bot token sealed for a connect challenge (floor)", () => {
  it("cannot be opened as a channel credential, and the challenge's sealed columns are empty after connect", async () => {
    const token = "bot-token-sealed-1:secret-value-1";
    const started = await post(`${BOT}/secret`, { secret: token });
    expect(started.status).toBe(200);
    const { challenge_id: challengeId, word } = await dataOf<{ challenge_id: string; word: string }>(started);
    const [onChallenge] = await q<SealedRow>(`SELECT ${SEALED} FROM app.connect_challenges WHERE id = $1`, [
      challengeId,
    ]);
    const salt = await saltOf();
    expect(onChallenge?.ciphertext).not.toBeNull();
    expect(
      open(
        storedOf(onChallenge as SealedRow),
        aadOf(workspace, challengeId, "bot_token"),
        keys,
        salt,
      ).expose(),
    ).toBe(token);

    queue.push({ text: `/connect ${word}`, chatId: "-1001", title: "Team chat" });
    await runPoll();
    const status = await fx.request(
      `/api/v1/workspaces/${workspace}/connect/${BOT}/challenge/${challengeId}`,
      {
        headers: { cookie: admin.cookie },
      },
    );
    expect(await dataOf(status)).toMatchObject({ state: "matched", chat_title: "Team chat" });
    const done = await post(`${BOT}/challenge/${challengeId}/complete`, { word });
    const { channel_id: channelId } = await dataOf<{ channel_id: string }>(done);

    const [cleared] = await q<SealedRow>(`SELECT ${SEALED} FROM app.connect_challenges WHERE id = $1`, [
      challengeId,
    ]);
    expect(Object.values(cleared ?? {}).every((value) => value === null)).toBe(true);
    const [onChannel] = await q<SealedRow>(
      `SELECT ${SEALED} FROM app.channel_credentials WHERE channel_id = $1 AND kind = 'bot_token'`,
      [channelId],
    );
    const stored = storedOf(onChannel as SealedRow);
    const onChannelToken = open(stored, aadOf(workspace, channelId, "bot_token"), keys, salt).expose();
    expect(JSON.parse(onChannelToken)).toEqual({ access_token: token });
    for (const wrong of [
      aadOf(workspace, challengeId, "bot_token"),
      aadOf(workspace, channelId, "channel_token"),
    ]) {
      expect(() => open(stored, wrong, keys, salt)).toThrow(EnvelopeError);
    }
  });
});

describe("a pasted secret never reaches a log or an answer (floor)", () => {
  it.each([
    [BOT, "bot_token", 'canary-bot-token-9:Zz/+=a b"c\\d'],
    [HOOK, "webhook_url", `https://${HOOK_HOST}/api/webhooks/1/canary-hook-token-9_Zz+a`],
  ])(
    "%s: the %s canary is absent in five forms from logs, answers and the audit log",
    async (provider, _kind, canary) => {
      const started = await post(`${provider}/secret`, { secret: canary });
      expect(started.status).toBe(200);
      if (provider === BOT) {
        const { challenge_id: id, word } = await dataOf<{ challenge_id: string; word: string }>(started);
        queue.push({ text: `/connect ${word}`, chatId: "-1002", title: "Second chat" });
        await runPoll();
        await post(`${BOT}/challenge/${id}/complete`, { word });
      }
      const audit = (await q<{ m: string }>("SELECT metadata::text AS m FROM app.audit_logs")).map(
        (r) => r.m,
      );
      const haystack = [...fx.logged, ...answers, ...audit].join("\n");
      expect(verified).toContain(canary);
      expect(leaks(haystack, [canary])).toEqual([]);
    },
  );
});

async function startFlow(body: object = {}): Promise<string> {
  await refill("connect_start");
  const answer = await fx.request(`/api/v1/workspaces/${workspace}/connect/${OAUTH}/start`, {
    method: "POST",
    headers: { cookie: admin.cookie },
    body,
  });
  const url = new URL((await dataOf<{ authorize_url: string }>(answer)).authorize_url);
  return url.searchParams.get("state") ?? "";
}
async function callbackParams(state: string, iss: string | undefined): Promise<URLSearchParams> {
  await refill("connect_callback");
  const query = new URLSearchParams({ code: "code-1", state, ...(iss === undefined ? {} : { iss }) });
  const answer = await fx.request(`/api/v1/connect/${OAUTH}/callback?${query}`, {
    headers: { cookie: admin.cookie },
  });
  return new URL(answer.headers.get("location") ?? "", ORIGIN).searchParams;
}
const callback = async (state: string, iss: string | undefined) =>
  (await callbackParams(state, iss)).get("reason") ?? "";

describe("the callback issuer of a flow (floor)", () => {
  it("authorize runs before the flow is stored, with no transaction open", async () => {
    const before = await countFlows();
    await startFlow();
    expect(flowsWhenAuthorized).toBe(before);
    expect(await countFlows()).toBe(before + 1);
  });

  it.each([
    ["a missing iss", undefined],
    ["another issuer", "https://other.example.test"],
  ])("%s is refused before the code exchange", async (_name, iss) => {
    const state = await startFlow();
    const exchanges = issuerExchanges;
    expect(await callback(state, iss)).toBe("refused");
    expect(issuerExchanges).toBe(exchanges);
  });

  it("the flow's own issuer reaches the code exchange", async () => {
    const state = await startFlow();
    const exchanges = issuerExchanges;
    await callback(state, ISSUER);
    expect(issuerExchanges).toBe(exchanges + 1);
  });
});

describe("the app of a provider that signs for the whole instance", () => {
  it("is made once, sealed under its own id, and given to authorize and the code exchange", async () => {
    grants = true;
    const first = await startFlow();
    await callbackParams(first, ISSUER);
    const second = await startFlow();
    await callbackParams(second, ISSUER);
    grants = false;
    expect(appsMade).toBe(1);
    expect(lastAuthorize?.app?.clientId).toBe("provider-client-1");
    expect(lastExchange?.app?.clientSecret.expose()).toBe("provider-app-secret-1");
    const stored = await q<{ secret_ciphertext: Buffer; redirect_uri: string }>(
      "SELECT secret_ciphertext, redirect_uri FROM app.provider_apps WHERE provider_id = $1",
      [OAUTH],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.secret_ciphertext.includes(Buffer.from("provider-app-secret-1"))).toBe(false);
    expect(stored[0]?.redirect_uri).toBe(`${ORIGIN}/api/v1/connect/${OAUTH}/callback`);
  });
});

describe("a flow that pushes its request and binds a key", () => {
  it("keeps the pushed request, key, issuer and hint for the exchange and stores the key and issuer with the token", async () => {
    grants = true;
    const state = await startFlow({ login_hint: "alice.example.test" });
    expect(lastAuthorize?.loginHint).toBe("alice.example.test");
    const result = await callbackParams(state, ISSUER);
    grants = false;
    expect(lastExchange).toMatchObject({
      requestUri: "urn:ietf:params:oauth:request_uri:par-1",
      issuer: ISSUER,
      loginHint: "alice.example.test",
    });
    expect(JSON.parse(lastExchange?.dpopKey?.expose() ?? "null")).toEqual(DPOP_JWK);
    const channel = result.get("channel") ?? "";
    const [row] = await q<SealedRow & { generation: number }>(
      `SELECT generation, ${SEALED} FROM app.channel_credentials WHERE channel_id = $1 AND kind = 'channel_token'`,
      [channel],
    );
    const aad = { ...aadOf(workspace, channel, "channel_token"), generation: row?.generation ?? 0 };
    const token = JSON.parse(open(storedOf(row as SealedRow), aad, keys, await saltOf()).expose());
    expect(token).toEqual({
      access_token: "par-access-1",
      dpop_private_jwk: DPOP_JWK,
      issuer: ISSUER,
    });
  });
});

describe("the steps a provider answer names", () => {
  it("names the secret a provider takes, and no login hint or public origin for these", async () => {
    const answer = await fx.request(`/api/v1/workspaces/${workspace}/providers`, {
      headers: { cookie: admin.cookie },
    });
    const { data } = (await answer.json()) as { data: Record<string, unknown>[] };
    expect(
      data.map((row) => [row.id, row.secret_kind, row.needs_login_hint, row.needs_public_origin]),
    ).toEqual([
      [BOT, "bot_token", false, false],
      [HOOK, "webhook_url", false, false],
      [OAUTH, null, false, false],
    ]);
  });
});
