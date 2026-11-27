import { SealedSecret } from "@shoutory/core/crypto";
import { withSystem } from "@shoutory/db/context/system";
import type { ConnectAdapter, ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wordDigest } from "../../src/channels/secret-connect.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

// The routes of the paste step and the challenge: who may call them, what another workspace's challenge answers, and
// that a webhook address on a host the manifest does not list never leaves the server.
const BOT = "fixture_route_bot";
const HOOK = "fixture_route_hook";
const HOOK_HOST = "hooks.example.test";
const permanent: ProviderResult = { ok: false, effect: "none", errorClass: "permanent" };
const checked: string[] = [];
const manifestOf = (id: string, method: "bot_token" | "webhook_url", host: string) =>
  manifestSchema.parse({ ...fixtureManifest, id, displayName: id, auth: { method }, egressHosts: [host] });
const connect: ConnectAdapter = {
  authorize: async () => ({ url: "https://issuer.example.test/" }),
  exchangeCode: async () => permanent,
  identity: async () => permanent,
  verifySecret: async (_context, input) => {
    checked.push(input.secret.expose());
    return {
      ok: true,
      effect: "none",
      identity: { providerAccountId: "route-account", accountKind: "bot", displayName: "Route account" },
    };
  },
};
const adapter: ProviderAdapter = {
  prepare: async () => permanent,
  commit: async () => permanent,
  readBack: async () => permanent,
  delete: async () => permanent,
  inspect: async () => ({ ok: true, effect: "none" }),
  connect,
};

let fx: Fixture;
let workspace: string;
let other: string;
const cookies: Record<string, string> = {};
let challenge = "";

beforeAll(async () => {
  fx = await startFixture({
    channels: {
      providers: {
        [BOT]: { manifest: manifestOf(BOT, "bot_token", "bots.example.test"), adapter },
        [HOOK]: { manifest: manifestOf(HOOK, "webhook_url", HOOK_HOST), adapter },
      },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "route-founder");
  const org = await seedOrganization(fx, founder.id);
  [workspace, other] = [await seedWorkspace(fx, org), await seedWorkspace(fx, org)];
  for (const [name, role] of [
    ["admin", "admin"],
    ["editor", "editor"],
    ["viewer", "viewer"],
  ] as const) {
    const user = await signedUser(fx, `route-${name}`);
    cookies[name] = user.cookie;
    await addWorkspaceMember(fx, workspace, user.id, role);
    if (name === "admin") await addWorkspaceMember(fx, other, user.id, role);
  }
  const made = await call("admin", workspace, "POST", `${BOT}/secret`, { secret: "route-bot-1:secret" });
  challenge = ((await made.json()) as { data: { challenge_id: string } }).data.challenge_id;
}, 90_000);
afterAll(() => fx.close());

async function call(who: string, ws: string, method: string, path: string, body?: object) {
  await fx.admin((c) =>
    c.query("DELETE FROM app.rate_buckets WHERE scope IN ('connect_start', 'connect_callback')"),
  );
  return fx.request(`/api/v1/workspaces/${ws}/connect/${path}`, {
    method,
    headers: { cookie: cookies[who] ?? "" },
    ...(body === undefined ? {} : { body }),
  });
}
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string; details?: { reason?: string } } };
  return [answer.status, error.code, error.details?.reason];
};

describe("the paste step and the challenge routes (floor)", () => {
  const routes = (id: string): [string, string, object | undefined][] => [
    ["POST", `${HOOK}/secret`, { secret: `https://${HOOK_HOST}/x` }],
    ["POST", `${BOT}/secret`, { secret: "route-bot-2:secret" }],
    ["GET", `${BOT}/challenge/${id}`, undefined],
    ["POST", `${BOT}/challenge/${id}/renew`, undefined],
    ["POST", `${BOT}/challenge/${id}/complete`, { word: "abcd234xyz" }],
  ];

  it.each(["editor", "viewer"])(
    "refuses a %s on every route and checks nothing with the provider",
    async (who) => {
      const before = checked.length;
      for (const [method, path, body] of routes(challenge)) {
        expect((await call(who, workspace, method, path, body)).status, `${method} ${path}`).toBe(403);
      }
      expect(checked).toHaveLength(before);
    },
  );

  it("answers the challenge of another workspace like one that does not exist, on status, renew and complete", async () => {
    const missing = "0190a000-0000-7000-8000-0000000000ff";
    for (const [method, path, body] of routes(challenge).slice(2)) {
      const foreign = await errorOf(await call("admin", other, method, path, body));
      const absent = await errorOf(
        await call("admin", other, method, path.replace(challenge, missing), body),
      );
      expect(foreign, `${method} ${path}`).toEqual(absent);
      expect(foreign[0]).toBe(404);
    }
  });

  it("refuses a webhook address on a host the manifest does not list, before any request leaves", async () => {
    const before = checked.length;
    const answer = await call("admin", workspace, "POST", `${HOOK}/secret`, {
      secret: "https://evil.example.test/api/webhooks/1/token",
    });
    expect(await errorOf(answer)).toEqual([422, "unprocessable_content", "host_not_allowed"]);
    expect(checked).toHaveLength(before);
  });
});

describe("a challenge an Admin renews and completes", () => {
  async function pasted(token: string) {
    const answer = await call("admin", workspace, "POST", `${BOT}/secret`, { secret: token });
    const { data } = (await answer.json()) as { data: { challenge_id: string; word: string } };
    return data;
  }
  // The chat answering is what the poll records; here the same call the poll makes.
  async function answered(id: string, word: string) {
    const [{ bot_digest: digest }] = (
      await fx.admin((c) => c.query("SELECT bot_digest FROM app.connect_challenges WHERE id = $1", [id]))
    ).rows as [{ bot_digest: Buffer }];
    await withSystem(fx.db.pool("worker"), "connect_challenge_poll", (tx) =>
      tx.query("SELECT app.connect_challenge_match($1, $2, $3, $4, $5)", [
        digest,
        wordDigest(word),
        "-1007",
        "Route chat",
        1,
      ]),
    );
  }

  it("renews to a new word on the same challenge", async () => {
    const { challenge_id: id, word } = await pasted("route-bot-3:secret");
    const answer = await call("admin", workspace, "POST", `${BOT}/challenge/${id}/renew`);
    const { data } = (await answer.json()) as { data: { word: string; expires_at: string } };
    expect(answer.status).toBe(200);
    expect(data.word).not.toBe(word);
    expect(Date.parse(data.expires_at)).toBeGreaterThan(Date.now());
  });

  it("refuses a wrong word and leaves the challenge ready, then completes with the right word", async () => {
    const { challenge_id: id, word } = await pasted("route-bot-4:secret");
    await answered(id, word);
    const wrong = await call("admin", workspace, "POST", `${BOT}/challenge/${id}/complete`, {
      word: "wrongword234",
    });
    expect(await errorOf(wrong)).toEqual([404, "not_found", undefined]);
    const right = await call("admin", workspace, "POST", `${BOT}/challenge/${id}/complete`, { word });
    const { data } = (await right.json()) as { data: { channel_id: string } };
    expect(right.status).toBe(200);
    expect(data.channel_id).toEqual(expect.any(String));
  });
});
