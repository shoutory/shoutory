import { SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { startFixtureOAuthSimulator } from "@shoutory/testkit/fixture-oauth/simulator";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_CLIENT } from "../support/oauth-fake.js";
import {
  addWorkspaceMember,
  seedChannel,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

// The actions of the channel answers: the server says what the caller may do with each channel and with the list, so a
// screen never derives an action. `connect` (the list) and `reconnect` (a row) need channels.manage and a provider with a
// connect side; `check` needs channels.manage, a connected channel and a provider the check can reach.

type User = { id: string; cookie: string };
type Registered = { fx: Fixture; ws: string; other: string; users: Record<string, User> };
const CONNECTING = "fixture_oauth";
const PLAIN = "fixture_plain";
const GONE = "fixture_gone";
const manifestOf = (id: string) => manifestSchema.parse({ ...fixtureOAuthManifest, id });
let sim: Awaited<ReturnType<typeof startFixtureOAuthSimulator>>;
let main: Registered;
let plainOnly: Registered;

// A registry, an organization with one member per role, and a second workspace of another organization.
async function register(providers: Record<string, boolean>, label: string): Promise<Registered> {
  const connecting = createFixtureAdapter({ baseUrl: sim.url, clientId: FAKE_CLIENT, issuer: sim.url });
  const plain = createFixtureAdapter({ baseUrl: sim.url });
  const fx = await startFixture({
    channels: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, connects]) => [
          id,
          { adapter: connects ? connecting : plain, manifest: manifestOf(id) },
        ]),
      ),
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, `${label}-org`);
  const ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  const users: Record<string, User> = {};
  for (const role of ["owner", "admin", "editor"]) {
    users[role] = await signedUser(fx, `${label}-${role}`);
    await addWorkspaceMember(fx, ws, users[role].id, role);
  }
  users.foreign = await signedUser(fx, `${label}-foreign`);
  const other = await seedWorkspace(fx, await seedOrganization(fx, users.foreign.id));
  await addWorkspaceMember(fx, other, users.foreign.id, "owner");
  return { fx, ws, other, users };
}

beforeAll(async () => {
  sim = await startFixtureOAuthSimulator({ now: () => new Date() });
  main = await register({ [CONNECTING]: true, [PLAIN]: false }, "act");
  plainOnly = await register({ [PLAIN]: false }, "actp");
}, 120_000);
afterAll(async () => {
  await sim.close();
  await main.fx.close();
  await plainOnly.fx.close();
});

const user = (r: Registered, name: string): User => {
  const found = r.users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const get = (r: Registered, who: string, path: string) =>
  r.fx.request(`/api/v1/workspaces/${r.ws}/channels${path}`, { headers: { cookie: user(r, who).cookie } });
interface Page {
  data: Array<{ id: string; actions: string[] }>;
  meta: { next_cursor: string | null; actions: string[] };
}
const pageOf = async (answer: Response) => (await answer.json()) as Page;
const actionsOf = async (r: Registered, who: string, id: string) =>
  ((await (await get(r, who, `/${id}`)).json()) as { data: { actions: string[] } }).data.actions;

describe("the actions of a channel follow the caller's role, the state and the provider", () => {
  it.each<[role: string, provider: string, state: string, expected: string[]]>([
    ["admin", CONNECTING, "connected", ["check"]],
    ["owner", CONNECTING, "connected", ["check"]],
    ["editor", CONNECTING, "connected", []],
    ["admin", CONNECTING, "needs_reconnect", ["reconnect"]],
    ["owner", CONNECTING, "disconnected", ["reconnect"]],
    ["admin", CONNECTING, "revoked_by_provider", ["reconnect"]],
    ["editor", CONNECTING, "needs_reconnect", []],
    ["admin", CONNECTING, "disabled", []],
    ["owner", CONNECTING, "disabled", []],
    // A provider with no connect side can be checked but never reconnected (start refuses it).
    ["admin", PLAIN, "connected", ["check"]],
    ["admin", PLAIN, "needs_reconnect", []],
    // A provider the registry does not hold has neither action.
    ["admin", GONE, "connected", []],
    ["admin", GONE, "needs_reconnect", []],
  ])("a %s on a channel of %s in state %s sees %j", async (role, provider, state, expected) => {
    const id = await seedChannel(main.fx, main.ws, state, undefined, provider);
    expect(await actionsOf(main, role, id)).toEqual(expected);
  });

  it("list, detail and the rename, disable and enable answers carry the same actions of one channel", async () => {
    const id = await seedChannel(main.fx, main.ws, "needs_reconnect", undefined, CONNECTING);
    const listed = (await pageOf(await get(main, "admin", ""))).data.find((row) => row.id === id);
    expect(listed?.actions).toEqual(["reconnect"]);
    expect(await actionsOf(main, "admin", id)).toEqual(["reconnect"]);
    const change = async (method: string, path: string, body?: object) =>
      (
        (await (
          await main.fx.request(`/api/v1/workspaces/${main.ws}/channels/${id}${path}`, {
            method,
            headers: { cookie: user(main, "admin").cookie },
            ...(body ? { body } : {}),
          })
        ).json()) as { data: { actions: string[] } }
      ).data.actions;
    expect(await change("PATCH", "", { nickname: "Renamed" })).toEqual(["reconnect"]);
    expect(await change("POST", "/disable")).toEqual([]);
    expect(await change("POST", "/enable")).toEqual(["reconnect"]);
  });

  it("a channel of another workspace is neither listed nor answered through this workspace", async () => {
    const foreign = await seedChannel(main.fx, main.other, "needs_reconnect", undefined, CONNECTING);
    expect((await pageOf(await get(main, "admin", ""))).data.map((row) => row.id)).not.toContain(foreign);
    expect((await get(main, "admin", `/${foreign}`)).status).toBe(404);
  });
});

describe("the page-level actions of the channel list", () => {
  it.each<[role: string, expected: string[]]>([
    ["owner", ["connect"]],
    ["admin", ["connect"]],
    ["editor", []],
  ])("a %s reads %j in meta.actions", async (role, expected) => {
    expect((await pageOf(await get(main, role, ""))).meta.actions).toEqual(expected);
  });

  it("an empty list still says what the caller may start", async () => {
    const lone = await seedWorkspace(main.fx, await seedOrganization(main.fx, user(main, "owner").id));
    await addWorkspaceMember(main.fx, lone, user(main, "admin").id, "admin");
    await addWorkspaceMember(main.fx, lone, user(main, "editor").id, "editor");
    const read = async (who: string) =>
      pageOf(
        await main.fx.request(`/api/v1/workspaces/${lone}/channels`, {
          headers: { cookie: user(main, who).cookie },
        }),
      );
    expect(await read("admin")).toMatchObject({ data: [], meta: { actions: ["connect"] } });
    expect(await read("editor")).toMatchObject({ data: [], meta: { actions: [] } });
  });

  it("a later page carries the same actions as the first", async () => {
    await seedChannel(main.fx, main.ws);
    await seedChannel(main.fx, main.ws);
    const first = await pageOf(await get(main, "admin", "?limit=1"));
    expect(first.meta.next_cursor).toEqual(expect.any(String));
    const second = await pageOf(await get(main, "admin", `?limit=1&cursor=${first.meta.next_cursor}`));
    expect(second.meta.actions).toEqual(first.meta.actions);
    expect(second.meta.actions).toEqual(["connect"]);
  });

  it("a registry with no provider that can connect offers no connect, even to an Admin", async () => {
    const page = await pageOf(await get(plainOnly, "admin", ""));
    expect(page.meta.actions).toEqual([]);
  });
});
