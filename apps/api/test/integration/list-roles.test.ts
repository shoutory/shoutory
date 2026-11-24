import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addOrganizationMember,
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

interface Row {
  id: string;
  role?: string;
  org_role?: string;
}
const list = async (cookie: string, path: string): Promise<Row[]> => {
  const answer = await fx.request(`${path}?limit=100`, { headers: { cookie } });
  return ((await answer.json()) as { data: Row[] }).data;
};

describe("the list routes answer the caller's own role", () => {
  it("organizations carry org_role for the caller's rows only, with the same keys on every row", async () => {
    const caller = await signedUser(fx, "roles-org");
    const other = await signedUser(fx, "roles-org-other");
    const owned = await seedOrganization(fx, caller.id);
    const joined = await seedOrganization(fx, other.id);
    await addOrganizationMember(fx, joined, caller.id, "member");
    const foreign = await seedOrganization(fx, other.id);
    const rows = await list(caller.cookie, "/api/v1/organizations");
    expect(Object.fromEntries(rows.map((row) => [row.id, row.org_role]))).toEqual({
      [owned]: "owner",
      [joined]: "member",
    });
    expect(rows.some((row) => row.id === foreign)).toBe(false);
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(["id", "name", "org_role", "slug", "type"]);
  });

  it("workspaces carry role for the caller's rows only: a viewer shows viewer, an implicit organization admin admin", async () => {
    const caller = await signedUser(fx, "roles-ws");
    const owner = await signedUser(fx, "roles-ws-owner");
    const viewerOrg = await seedOrganization(fx, owner.id);
    const viewed = await seedWorkspace(fx, viewerOrg);
    await addWorkspaceMember(fx, viewed, caller.id, "viewer");
    const adminOrg = await seedOrganization(fx, owner.id);
    await addOrganizationMember(fx, adminOrg, caller.id, "admin");
    const administered = await seedWorkspace(fx, adminOrg);
    const foreign = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
    const rows = await list(caller.cookie, "/api/v1/workspaces");
    expect(Object.fromEntries(rows.map((row) => [row.id, row.role]))).toEqual({
      [viewed]: "viewer",
      [administered]: "admin",
    });
    expect(rows.some((row) => row.id === foreign)).toBe(false);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["id", "name", "organization_id", "role", "slug"]);
    }
  });
});
