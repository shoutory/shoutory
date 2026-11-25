import { countText } from "@shoutory/core/counting";
import { SealedSecret } from "@shoutory/core/crypto";
import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import { startMastodonSimulator } from "@shoutory/provider-mastodon/simulator";
import { egressFetch } from "@shoutory/provider-sdk/egress";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import { fetchOf } from "@shoutory/provider-sdk/egress/fetch-adapter";
import { createOperatorPolicy } from "@shoutory/provider-sdk/egress/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaks } from "../support/canary.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, ORIGIN, PEPPER, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
const PROVIDER = mastodonManifest.id;
const INTERNAL = "internal.example.test";
const UNREACHABLE = "unreachable.example.test";
const REFUSED_HOSTS = [INTERNAL];
let fx: Fixture;
let sim: Awaited<ReturnType<typeof startMastodonSimulator>>;
let workspace: string;
let otherWorkspace: string;
let admin: User;
let admin2: User;

const operator = createOperatorPolicy({
  allowCidrs: [],
  lookup: async (host) => [{ address: host === INTERNAL ? "10.0.0.5" : "93.184.216.34", family: 4 }],
});
const toSimulator: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
};
// A name that does not resolve fails in the egress client exactly as it does in production.
const unresolved = fetchOf(async (req) => {
  throw new EgressError({ class: "dns", host: new URL(req.url).hostname });
});
const fetchFor = (_manifest: unknown, host: string | undefined): typeof fetch => {
  if (host === UNREACHABLE) return unresolved;
  return host !== undefined && REFUSED_HOSTS.includes(host)
    ? fetchOf((req) => egressFetch(req, { request: { kind: "instance", host }, operator }))
    : toSimulator;
};

beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
  fx = await startFixture({
    channels: {
      providers: { [PROVIDER]: { adapter: createMastodonAdapter(), manifest: mastodonManifest } },
      fetch,
      fetchFor,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "instance-founder");
  const org = await seedOrganization(fx, founder.id);
  [workspace, otherWorkspace] = [await seedWorkspace(fx, org), await seedWorkspace(fx, org)];
  [admin, admin2] = [await signedUser(fx, "instance-admin"), await signedUser(fx, "instance-admin2")];
  for (const who of [admin, admin2]) await addWorkspaceMember(fx, workspace, who.id, "admin");
  await addWorkspaceMember(fx, otherWorkspace, admin.id, "admin");
}, 90_000);
afterAll(async () => {
  await sim.close();
  await fx.close();
});

const q = <T>(sql: string, params: unknown[] = []) =>
  fx.admin(async (c) => (await c.query(sql, params)).rows as T[]);
let nextHost = 1;
const newHost = () => `instance-${nextHost++}.example`;
const answers: string[] = [];

// Every start and callback spends a per-user bucket; these rows test the connect, not the limit.
const refill = (who: User, scope: "connect_start" | "connect_callback") =>
  q("DELETE FROM app.rate_buckets WHERE scope = $1 AND key = $2", [scope, fx.auth.bucketKey(scope, who.id)]);
async function startWith(who: User, body: object, ws = workspace): Promise<Response> {
  await refill(who, "connect_start");
  const answer = await fx.request(`/api/v1/workspaces/${ws}/connect/${PROVIDER}/start`, {
    method: "POST",
    headers: { cookie: who.cookie },
    body,
  });
  answers.push(await answer.clone().text());
  return answer;
}
const start = (who: User, host: string) => startWith(who, { instance_host: host });
const authorizeUrl = async (answer: Response) =>
  ((await answer.json()) as { data: { authorize_url: string } }).data.authorize_url;
const errorOf = async (answer: Response) =>
  ((await answer.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
async function approve(url: string): Promise<URLSearchParams> {
  const target = new URL(url);
  const answer = await fetch(new URL(`${target.pathname}${target.search}`, sim.url), { redirect: "manual" });
  return new URL(answer.headers.get("location") ?? "").searchParams;
}
async function callback(who: User, params: URLSearchParams): Promise<URLSearchParams> {
  await refill(who, "connect_callback");
  const answer = await fx.request(`/api/v1/connect/${PROVIDER}/callback?${params}`, {
    headers: { cookie: who.cookie },
  });
  const location = answer.headers.get("location") ?? "";
  answers.push(location);
  return new URL(location, ORIGIN).searchParams;
}
async function connect(who: User, host: string, ws = workspace) {
  const url = await authorizeUrl(await startWith(who, { instance_host: host }, ws));
  return {
    clientId: new URL(url).searchParams.get("client_id"),
    scope: new URL(url).searchParams.get("scope"),
    result: await callback(who, await approve(url)),
  };
}
const storedApps = (host: string) =>
  q<{ client_id: string; secret_ciphertext: Buffer }>(
    "SELECT client_id, secret_ciphertext FROM app.provider_instance_apps WHERE provider_id = $1 AND instance_host = $2",
    [PROVIDER, host],
  );

describe("the per-instance app of a connect (floor)", () => {
  it("registers one app per instance, reuses it, and registers again after the instance answers 401 for the app", async () => {
    sim.reset();
    const host = newHost();
    const first = await connect(admin, host);
    expect(first.result.get("channel")).not.toBeNull();
    expect(sim.apps).toHaveLength(1);
    expect(await storedApps(host)).toMatchObject([{ client_id: sim.apps[0]?.clientId }]);
    expect(first.clientId).toBe(sim.apps[0]?.clientId);

    const again = await connect(admin2, host);
    expect(again.clientId).toBe(first.clientId);
    expect(sim.apps).toHaveLength(1);

    sim.revokeApps();
    const refused = await connect(admin, host);
    expect(refused.clientId).toBe(first.clientId);
    expect(refused.result.get("reason")).toBe("start_again");
    expect(sim.apps).toHaveLength(2);
    expect(await storedApps(host)).toMatchObject([{ client_id: sim.apps[1]?.clientId }]);

    const renewed = await connect(admin, host);
    expect(renewed.clientId).toBe(sim.apps[1]?.clientId);
    expect(renewed.result.get("channel")).not.toBeNull();
  });

  it("two first connects to one instance at once leave one stored app, and both authorization URLs carry it", async () => {
    sim.reset();
    const host = newHost();
    const urls = await Promise.all([start(admin, host), start(admin2, host)]).then((both) =>
      Promise.all(both.map(authorizeUrl)),
    );
    const stored = await storedApps(host);
    expect(stored).toHaveLength(1);
    expect(urls.map((url) => new URL(url).searchParams.get("client_id"))).toEqual([
      stored[0]?.client_id,
      stored[0]?.client_id,
    ]);
  });
});

describe("the secrets of a connect stay sealed (floor)", () => {
  it("seals the app secret and the token: neither is in a log, an answer, an audit row or a stored column, in any of six forms", async () => {
    sim.reset();
    const host = newHost();
    expect((await connect(admin, host)).result.get("channel")).not.toBeNull();
    const secrets = [sim.apps[0]?.clientSecret ?? "", sim.tokens[0] ?? ""];
    expect(secrets.every((secret) => secret.length >= 16)).toBe(true);
    const rows = await Promise.all(
      ["audit_logs", "channels", "channel_capability_snapshots", "oauth_flows"].map((table) =>
        q(`SELECT row_to_json(t)::text AS t FROM app.${table} t`),
      ),
    );
    const haystack = [fx.logged.join("\n"), answers.join("\n"), JSON.stringify(rows)].join("\n");
    expect(leaks(haystack, secrets)).toEqual([]);
    const [app] = await storedApps(host);
    expect(app?.secret_ciphertext.includes(Buffer.from(secrets[0] ?? ""))).toBe(false);
  });
});

describe("an instance that cannot be connected to is refused at the start (floor)", () => {
  // An address is no instance host at all; a name the operator policy refuses is refused by the egress policy.
  it.each([
    ["169.254.169.254", "host_invalid"],
    [INTERNAL, "address_not_allowed"],
  ])(
    "the host %s, an address or a name the operator policy refuses, answers 422 %s and stores nothing",
    async (host, reason) => {
      sim.reset();
      const answer = await start(admin, host);
      expect(answer.status).toBe(422);
      expect(await errorOf(answer)).toMatchObject({ code: "unprocessable_content", details: { reason } });
      expect(await storedApps(host)).toEqual([]);
      expect(sim.requests).toEqual([]);
    },
  );

  it.each([
    ["has no discovery document (404)", "missing"],
    ["does not list S256 in code_challenge_methods_supported", "no_s256"],
  ] as const)(
    "an instance that %s answers 422 with the reason instance_unsupported and stores nothing",
    async (_name, discovery) => {
      sim.reset({ discovery });
      const host = newHost();
      const answer = await start(admin, host);
      expect(answer.status).toBe(422);
      expect(await errorOf(answer)).toMatchObject({
        code: "unprocessable_content",
        details: { reason: "instance_unsupported" },
      });
      expect(await storedApps(host)).toEqual([]);
    },
  );
});

describe("the limits of a connected channel come from the instance's own answer", () => {
  const INSTANCE_LIMITS = { maxCharacters: 777, reservedPerUrl: 30, maxMedia: 3, imageSizeLimit: 9_999_999 };

  it("stores the instance's limits, each with its source and date, and countText counts with them", async () => {
    sim.reset({ limits: INSTANCE_LIMITS });
    const host = newHost();
    const channel = (await connect(admin, host)).result.get("channel");
    const [snapshot] = await q<{
      limits: Record<string, { value: number; source: string; checked: string }>;
    }>(
      "SELECT limits FROM app.channel_capability_snapshots WHERE channel_id = $1 ORDER BY epoch DESC LIMIT 1",
      [channel],
    );
    const limits = snapshot?.limits ?? {};
    expect(Object.fromEntries(Object.entries(limits).map(([name, one]) => [name, one.value]))).toMatchObject({
      textLength: 777,
      urlWeight: 30,
      mediaMaxCount: 3,
      imageMaxBytes: 9_999_999,
    });
    expect(limits.textLength).toMatchObject({
      source: `https://${host}/api/v2/instance`,
      checked: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // The manifest's own number is only the documented default: the stored limit is not it.
    expect(limits.textLength?.value).not.toBe(mastodonManifest.limits.textLength?.value);
    const rule = { ...mastodonManifest.counting, urlWeight: limits.urlWeight?.value };
    expect(countText(rule, "ab https://example.com/a-very-long-path-that-is-longer-than-thirty")).toBe(33);
    expect(countText(rule, "a".repeat(778))).toBeGreaterThan(limits.textLength?.value ?? 0);
  });

  it("logs the limits the instance left out, by provider and field only", async () => {
    sim.reset({ limits: { ...INSTANCE_LIMITS, maxCharacters: null } });
    const host = newHost();
    const before = fx.logged.length;
    await connect(admin, host);
    const lines = fx.logged.slice(before).filter((line) => line.includes("instance_limits_from_manifest"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("textLength");
    expect(lines[0]).not.toContain(host);
  });
});

const channelState = async (channel: string | null) =>
  (
    await q<{ instance_host: string | null; generation: number; token: string; expires: Date | null }>(
      `SELECT c.instance_host, k.generation, encode(k.ciphertext, 'hex') AS token, k.access_expires_at AS expires
       FROM app.channels c JOIN app.channel_credentials k ON k.workspace_id = c.workspace_id AND k.channel_id = c.id
       WHERE c.id = $1 AND k.state = 'active'`,
      [channel],
    )
  )[0];

describe("the identity of a channel on a user-chosen instance (floor)", () => {
  it("the same account id on two instances gives two channels and leaves the first one's host and token", async () => {
    sim.reset();
    const [hostA, hostB] = [newHost(), newHost()];
    const first = (await connect(admin, hostA)).result.get("channel");
    const before = await channelState(first);
    const second = (await connect(admin, hostB)).result.get("channel");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(before).toMatchObject({ instance_host: hostA });
    expect(await channelState(first)).toEqual(before);
    expect(await channelState(second)).toMatchObject({ instance_host: hostB });
  });
});

describe("a token that never expires", () => {
  it("is stored with no expiry and so is never due for a refresh", async () => {
    sim.reset();
    const channel = (await connect(admin, newHost())).result.get("channel");
    expect((await channelState(channel))?.expires).toBeNull();
    const [row] = await q<{ token_expires_at: Date | null }>(
      "SELECT token_expires_at FROM app.channels WHERE id = $1",
      [channel],
    );
    expect(row?.token_expires_at).toBeNull();
  });
});

const flowsOn = (host: string) =>
  q<{ channel_id: string | null }>("SELECT channel_id FROM app.oauth_flows WHERE instance_host = $1", [host]);
const authorizeHost = async (answer: Response) => new URL(await authorizeUrl(answer)).host;

describe("the instance host a person types", () => {
  it("in capitals, with a scheme, a path and a trailing dot reaches the one stored host", async () => {
    sim.reset();
    const host = newHost();
    const answer = await start(admin, ` HTTPS://${host.toUpperCase()}./about `);
    expect(answer.status).toBe(200);
    expect(await authorizeHost(answer)).toBe(host);
    expect(await storedApps(host)).toHaveLength(1);
    expect(await flowsOn(host)).toHaveLength(1);
  });

  it.each([
    ["another scheme", "http://plain.example"],
    ["another port", "social.example:8443"],
    ["a name with no dot", "localhost"],
  ])("with %s answers 422 host_invalid and asks the instance nothing", async (_name, typed) => {
    sim.reset();
    const answer = await start(admin, typed);
    expect(answer.status).toBe(422);
    expect(await errorOf(answer)).toMatchObject({
      code: "unprocessable_content",
      details: { reason: "host_invalid" },
    });
    expect(sim.requests).toEqual([]);
  });
});

describe("a reconnect of an instance channel takes the channel's own host (floor)", () => {
  it("with no host typed, starts on the channel's host and binds the flow to the channel", async () => {
    sim.reset();
    const host = newHost();
    const channel = (await connect(admin, host)).result.get("channel");
    const answer = await startWith(admin, { channel_id: channel });
    expect(answer.status).toBe(200);
    expect(await authorizeHost(answer)).toBe(host);
    expect(await flowsOn(host)).toContainEqual({ channel_id: channel });
  });

  it("with another host typed, answers 422 host_mismatch and stores no flow on either host", async () => {
    sim.reset();
    const [host, typed] = [newHost(), newHost()];
    const channel = (await connect(admin, host)).result.get("channel");
    const before = await flowsOn(host);
    const answer = await startWith(admin, { channel_id: channel, instance_host: typed });
    expect(answer.status).toBe(422);
    expect(await errorOf(answer)).toMatchObject({ details: { reason: "host_mismatch" } });
    expect([await flowsOn(host), await flowsOn(typed)]).toEqual([before, []]);
  });

  it("with a channel of another workspace, answers 404 and stores nothing", async () => {
    sim.reset();
    const host = newHost();
    const foreign = (await connect(admin, host, otherWorkspace)).result.get("channel");
    const before = await flowsOn(host);
    const answer = await startWith(admin, { channel_id: foreign });
    expect(answer.status).toBe(404);
    expect(await flowsOn(host)).toEqual(before);
  });
});

describe("a stored app serves only the scope set it was registered for (floor)", () => {
  it("an app stored for another scope set is not reused: a new app is registered and stored beside it", async () => {
    sim.reset();
    const host = newHost();
    const first = await connect(admin, host);
    const [stored] = await q<{ scopes: string }>(
      "SELECT scopes FROM app.provider_instance_apps WHERE instance_host = $1",
      [host],
    );
    expect(stored?.scopes).toBe(first.scope?.split(" ").sort().join(" "));
    await q("UPDATE app.provider_instance_apps SET scopes = 'read' WHERE instance_host = $1", [host]);
    const second = await connect(admin, host);
    expect(sim.apps).toHaveLength(2);
    expect(second.clientId).not.toBe(first.clientId);
    expect(second.result.get("channel")).not.toBeNull();
    expect(await storedApps(host)).toHaveLength(2);
  });
});

describe("an instance failure keeps its reason to the answer", () => {
  it("a name that does not resolve answers 503 with the reason instance_unreachable", async () => {
    const answer = await start(admin, UNREACHABLE);
    expect(answer.status).toBe(503);
    expect(await errorOf(answer)).toMatchObject({ details: { reason: "instance_unreachable" } });
    expect(await storedApps(UNREACHABLE)).toEqual([]);
  });

  it("a 4xx to the registration answers 422 with the reason instance_refused", async () => {
    sim.reset();
    sim.faults.failNext("POST /api/v1/apps", { kind: "respond", status: 403, body: { error: "closed" } });
    const host = newHost();
    const answer = await start(admin, host);
    expect(answer.status).toBe(422);
    expect(await errorOf(answer)).toMatchObject({ details: { reason: "instance_refused" } });
    expect(await storedApps(host)).toEqual([]);
  });

  it("a 429 to the registration answers 429 with the reason instance_rate_limited and the instance's Retry-After", async () => {
    sim.reset();
    const fault = { kind: "respond", status: 429, headers: { "retry-after": "120" } } as const;
    sim.faults.failNext("POST /api/v1/apps", fault);
    const answer = await start(admin, newHost());
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("120");
    expect(await errorOf(answer)).toMatchObject({ details: { reason: "instance_rate_limited" } });
  });
});
