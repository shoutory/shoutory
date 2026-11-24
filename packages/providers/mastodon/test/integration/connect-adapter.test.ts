import { inspect } from "node:util";
import { SealedSecret } from "@shoutory/core/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";

// The connect side of the adapter against the simulator of a Mastodon instance (built from docs.joinmastodon.org, each
// endpoint with its URL and access date in the simulator). The adapter is given only the instance host a channel stored:
// its fetch, here a recorder that rewrites every request onto the simulator, must be asked for that host and no other,
// whatever a document the instance answers names. A refusal of the instance is the adapter's call, answered as a result
// with the code `instance_unsupported`, never thrown. The shapes of `registerApp` and its result are the contract the
// adapter must meet: `{ ok, app?: { clientId, clientSecret }, providerCode? }` with the secret still sealed.
let sim: MastodonSimulator;
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const HOST = "social.example";
const REDIRECT = "https://app.example.test/api/v1/connect/mastodon/callback";

// A fetch that records the host each request asked for and sends it to the simulator, whatever the host.
function recorder() {
  const hosts: string[] = [];
  const send: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.host);
    return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  };
  return { hosts, context: { fetch: send, now: () => new Date() } };
}
const register = (context: ReturnType<typeof recorder>["context"]) => {
  const connect = createMastodonAdapter().connect;
  if (!connect?.registerApp) throw new Error("the adapter has no registerApp");
  return connect.registerApp(context, { instanceHost: HOST, redirectUri: REDIRECT });
};

describe("registerApp (floor)", () => {
  it("registers one app on the instance and answers its client id with the secret still sealed", async () => {
    sim.reset();
    const { context } = recorder();
    const answer = await register(context);
    expect(answer.ok).toBe(true);
    expect(sim.apps).toHaveLength(1);
    expect(answer.app?.clientId).toBe(sim.apps[0]?.clientId);
    expect(answer.app?.clientSecret.expose()).toBe(sim.apps[0]?.clientSecret);
  });

  it("never shows the client secret in any string form of its answer (raw, percent-encoded, hex, base64, base64url, JSON-escaped)", async () => {
    sim.reset();
    const answer = await register(recorder().context);
    const secret = sim.apps[0]?.clientSecret ?? "";
    expect(secret.length).toBeGreaterThanOrEqual(16);
    const shown = [
      inspect(answer, { depth: 6 }),
      JSON.stringify(answer),
      String(answer.app?.clientSecret),
    ].join("\n");
    const forms = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      JSON.stringify(secret).slice(1, -1),
    ];
    expect(forms.filter((form) => shown.includes(form))).toEqual([]);
  });

  it("asks only for the instance host it was given, even when the discovery document names other hosts' endpoints", async () => {
    sim.reset({ discovery: "foreign_endpoints" });
    const { hosts, context } = recorder();
    await register(context);
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)]).toEqual([HOST]);
  });

  it.each([
    ["a discovery document that is not found (404)", "missing"],
    ["a discovery document that lacks S256 in code_challenge_methods_supported", "no_s256"],
  ] as const)(
    "refuses an instance with %s as instance_unsupported and registers nothing",
    async (_name, discovery) => {
      sim.reset({ discovery });
      const answer = await register(recorder().context);
      expect(answer).toMatchObject({
        ok: false,
        errorClass: "permanent",
        providerCode: "instance_unsupported",
      });
      expect(sim.apps).toHaveLength(0);
    },
  );
});

// BG-14: the health of a channel is what `verify_credentials` says of its token. A body that is no account (a stub, a
// proxy's page) is refused, never read as healthy; a 401 is a revoked token.
describe("inspect: verify_credentials decides health", () => {
  const inspectWith = async (verify: "ok" | "revoked" | "stub" | "not_json") => {
    sim.reset({ verify });
    const accessToken = new SealedSecret(sim.issueToken());
    return createMastodonAdapter().inspect(recorder().context, { accessToken, instanceHost: HOST });
  };

  it("an account answer is a healthy channel and carries the instance's limits", async () => {
    expect(await inspectWith("ok")).toMatchObject({
      ok: true,
      health: "ok",
      effect: "none",
      limits: { textLength: { value: 500 } },
    });
  });

  // A limit an instance states is bounded (characters 1,000,000, attachments 100, bytes 16 GiB): one beyond is no limit.
  it.each([
    ["maxCharacters", 1_000_001],
    ["maxMedia", 101],
    ["imageSizeLimit", 17_179_869_185],
  ] as const)(
    "an instance that states %s of %i gives no limits and is still healthy",
    async (name, value) => {
      sim.reset({ limits: { [name]: value } });
      const accessToken = new SealedSecret(sim.issueToken());
      const answer = await createMastodonAdapter().inspect(recorder().context, {
        accessToken,
        instanceHost: HOST,
      });
      expect(answer).toMatchObject({ ok: true, health: "ok" });
      expect(answer.limits).toBeUndefined();
    },
  );

  it("a 401 is a revoked token", async () => {
    expect(await inspectWith("revoked")).toMatchObject({
      ok: false,
      errorClass: "auth_revoked",
      httpStatus: 401,
    });
  });

  it.each([
    ["an object with no account id", "stub"],
    ["a body that is not JSON", "not_json"],
  ] as const)("%s is refused as an unknown answer, never as healthy", async (_name, verify) => {
    expect(await inspectWith(verify)).toMatchObject({ ok: false, errorClass: "unknown", effect: "none" });
  });
});
