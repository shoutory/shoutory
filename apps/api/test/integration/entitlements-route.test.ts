import type { Entitlements } from "@shoutory/core/entitlements";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

const limited: Entitlements = {
  check: async (_workspace, key) =>
    key === "workspaces" ? { kind: "limited", limit: 5, used: 2 } : { kind: "unlimited" },
};

const strange = { check: async () => ({ kind: "metered" }) } as unknown as Entitlements;

let selfHost: Fixture;
let planned: Fixture;
let unknown: Fixture;
beforeAll(async () => {
  selfHost = await startFixture();
  planned = await startFixture({ entitlements: limited });
  unknown = await startFixture({ entitlements: strange });
});
afterAll(async () => {
  await selfHost.close();
  await planned.close();
  await unknown.close();
});

const path = (id: string) => `/api/v1/workspaces/${id}/entitlements`;
async function member(fx: Fixture, role: string) {
  const owner = await signedUser(fx, "ent-owner");
  const user = await signedUser(fx, `ent-${role}`);
  const workspace = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
  await addWorkspaceMember(fx, workspace, user.id, role);
  return { cookie: user.cookie, workspace };
}

describe("GET /api/v1/workspaces/{workspace_id}/entitlements", () => {
  it("a member of the workspace reads exactly the two keys, unlimited on self-host", async () => {
    const { cookie, workspace } = await member(selfHost, "viewer");
    const answer = await selfHost.request(path(workspace), { headers: { cookie } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      data: { workspaces: { kind: "unlimited" }, members: { kind: "unlimited" } },
    });
  });

  it("answers 500 for an unknown kind of entitlement, never unlimited", async () => {
    const { cookie, workspace } = await member(unknown, "viewer");
    expect((await unknown.request(path(workspace), { headers: { cookie } })).status).toBe(500);
  });

  it("answers a limited entitlement with its limit and use, from the injected implementation", async () => {
    const { cookie, workspace } = await member(planned, "viewer");
    const answer = await planned.request(path(workspace), { headers: { cookie } });
    expect(await answer.json()).toEqual({
      data: { workspaces: { kind: "limited", limit: 5, used: 2 }, members: { kind: "unlimited" } },
    });
  });

  it("answers a workspace the caller does not reach like a missing one, and no session 401", async () => {
    const outsider = await signedUser(selfHost, "ent-outsider");
    const { workspace } = await member(selfHost, "viewer");
    const foreign = await selfHost.request(path(workspace), { headers: { cookie: outsider.cookie } });
    const missing = await selfHost.request(path("0190a000-0000-7000-8000-00000000dead"), {
      headers: { cookie: outsider.cookie },
    });
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    const code = async (answer: Response) =>
      ((await answer.json()) as { error: { code: string } }).error.code;
    expect([await code(foreign), await code(missing)]).toEqual(["not_found", "not_found"]);
    expect((await selfHost.request(path(workspace))).status).toBe(401);
  });
});
