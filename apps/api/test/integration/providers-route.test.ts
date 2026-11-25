import { SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { startFixtureOAuthSimulator } from "@shoutory/testkit/fixture-oauth/simulator";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_CLIENT } from "../support/oauth-fake.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
let fx: Fixture;
let sim: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
let ws: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
const MISSING = "019a0000-0000-7000-8000-000000000000";
const ALLOWLIST = ["auth_kind", "connectable", "display_name", "id", "lifecycle", "needs_instance_host"];
const manifestOf = (id: string, displayName: string, lifecycle: "beta" | "ga") =>
  manifestSchema.parse({ ...fixtureOAuthManifest, id, displayName, lifecycle });
// A provider whose host is the one each channel stores (an instance network) needs the host typed at the start.
const instanceManifestOf = (id: string, displayName: string) => {
  const { egressHosts: _hosts, ...rest } = fixtureOAuthManifest;
  return manifestSchema.parse({ ...rest, id, displayName, lifecycle: "beta", egressHostSource: "channel" });
};

beforeAll(async () => {
  sim = await startFixtureOAuthSimulator({ now: () => new Date() });
  // Declared in reverse id order, so the sorted answer is the route's doing. The second adapter has no client id and
  // so no connect side.
  fx = await startFixture({
    channels: {
      providers: {
        fixture_beta: {
          adapter: createFixtureAdapter({ baseUrl: sim.url }),
          manifest: instanceManifestOf("fixture_beta", "Beta Network"),
        },
        fixture_alpha: {
          adapter: createFixtureAdapter({ baseUrl: sim.url, clientId: FAKE_CLIENT, issuer: sim.url }),
          manifest: manifestOf("fixture_alpha", "Alpha Network", "ga"),
        },
      },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "prov-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `prov-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  const other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await sim.close();
  await fx.close();
});

const providers = (who: User, workspace = ws) =>
  fx.request(`/api/v1/workspaces/${workspace}/providers`, { headers: { cookie: who.cookie } });
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string } };
  return [answer.status, error.code];
};

describe("who may read the providers (channels.view)", () => {
  it.each([
    ["owner", 200],
    ["admin", 200],
    ["editor", 200],
    ["approver", 403],
    ["viewer", 403],
  ])("a %s gets %i", async (role, status) => {
    expect((await providers(user(role))).status).toBe(status);
  });

  it.each(["outsider", "foreign"])(
    "%s (a non-member, a member of another workspace) gets the identical 404 as for a missing workspace",
    async (who) => {
      const real = await providers(user(who));
      const missing = await providers(user(who), MISSING);
      expect(real.status).toBe(404);
      expect(await errorOf(real)).toEqual(await errorOf(missing));
    },
  );

  it("a caller who is not signed in gets 401", async () => {
    expect((await fx.request(`/api/v1/workspaces/${ws}/providers`)).status).toBe(401);
  });
});

describe("what the providers route answers", () => {
  it("lists every registered provider by id with exactly the allowlisted fields, the display name from its manifest and whether it can connect", async () => {
    const answer = await providers(user("admin"));
    const text = await answer.text();
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((row) => Object.keys(row).sort())).toEqual([ALLOWLIST, ALLOWLIST]);
    expect(body.data).toEqual([
      {
        id: "fixture_alpha",
        display_name: "Alpha Network",
        lifecycle: "ga",
        auth_kind: "oauth2_pkce",
        connectable: true,
        needs_instance_host: false,
      },
      {
        id: "fixture_beta",
        display_name: "Beta Network",
        lifecycle: "beta",
        auth_kind: "oauth2_pkce",
        connectable: false,
        needs_instance_host: true,
      },
    ]);
    // Nothing of the manifest's internals or of the adapter reaches the answer: scopes, hosts, capabilities, limits.
    for (const internal of fixtureOAuthManifest.scopes) expect(text).not.toContain(internal);
    expect(text).not.toContain(new URL(sim.url).host);
    expect(text).not.toContain("capabilities");
  });
});
