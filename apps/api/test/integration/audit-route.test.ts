import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  unique,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
let fx: Fixture;
let ws: string;
let other: string;
let owner: User;
let admin: User;
let viewer: User;
let outsider: User;
let foreign: User;
const invited: string[] = [];
let foreignRowId: string;
let foreignInvitation: string;

const MISSING = "019a0000-0000-7000-8000-000000000000";
const audit = (id: string, who: User, query = "") =>
  fx.request(`/api/v1/workspaces/${id}/audit-logs${query}`, { headers: { cookie: who.cookie } });
const invite = async (id: string, who: User): Promise<string> => {
  const body = { email: `${unique("audit-invitee")}@example.test`, role_key: "viewer" };
  const answer = await fx.request(`/api/v1/workspaces/${id}/invitations`, {
    method: "POST",
    headers: { cookie: who.cookie },
    body,
  });
  return ((await answer.json()) as { data: { id: string } }).data.id;
};
type Row = Record<string, unknown>;
const rowsOf = async (answer: Response) => {
  expect(answer.status).toBe(200);
  return (await answer.json()) as { data: Row[]; meta: { next_cursor: string | null } };
};

beforeAll(async () => {
  fx = await startFixture();
  [owner, admin, viewer, outsider, foreign] = (await Promise.all(
    ["owner", "admin", "viewer", "outsider", "foreign"].map((name) => signedUser(fx, `audit-${name}`)),
  )) as [User, User, User, User, User];
  ws = await seedWorkspace(fx, await seedOrganization(fx, owner.id));
  other = await seedWorkspace(fx, await seedOrganization(fx, foreign.id));
  await addWorkspaceMember(fx, ws, owner.id, "owner");
  await addWorkspaceMember(fx, ws, admin.id, "admin");
  await addWorkspaceMember(fx, ws, viewer.id, "viewer");
  await addWorkspaceMember(fx, other, foreign.id, "owner");
  for (let i = 0; i < 3; i++) invited.push(await invite(ws, owner));
  foreignInvitation = await invite(other, foreign);
  foreignRowId = await fx.admin(
    async (client) =>
      (await client.query("SELECT id FROM app.audit_logs WHERE resource_id = $1", [foreignInvitation]))
        .rows[0].id,
  );
}, 60_000);
afterAll(() => fx.close());

describe("GET /api/v1/workspaces/{workspace_id}/audit-logs", () => {
  it("the Owner reads this workspace's rows newest first, one page at a time, and no other workspace's row", async () => {
    const first = await rowsOf(await audit(ws, owner, "?limit=2"));
    expect(first.data.map((row) => row.resource_id)).toEqual([invited[2], invited[1]]);
    expect(first.meta.next_cursor).toBe(first.data[1]?.id);
    const second = await rowsOf(await audit(ws, owner, `?limit=2&cursor=${first.meta.next_cursor}`));
    expect(second.data.map((row) => row.resource_id)).toEqual([invited[0]]);
    const all = JSON.stringify([first.data, second.data]);
    expect(all).not.toContain(foreignInvitation);
  });

  it.each([
    ["an Admin", () => audit(ws, admin)],
    ["a Viewer", () => audit(ws, viewer)],
  ])("%s gets 403 forbidden and no row", async (_label, ask) => {
    const answer = await ask();
    const text = await answer.text();
    expect(answer.status).toBe(403);
    expect(text).toContain("forbidden");
    expect(text).not.toContain(invited[0]);
  });

  it("a non-member and a member of another workspace get the 404 of a missing workspace, with no row", async () => {
    expect((await audit(ws, owner)).status).toBe(200);
    const missing = await audit(MISSING, outsider);
    const missingError = ((await missing.json()) as { error: { code: string; message: string } }).error;
    for (const who of [outsider, foreign]) {
      const answer = await audit(ws, who);
      expect(answer.status).toBe(404);
      const { error } = (await answer.json()) as { error: { code: string; message: string } };
      expect([error.code, error.message]).toEqual([missingError.code, missingError.message]);
    }
  });
});

describe("the audit page's cursor and fields", () => {
  it("a cursor that is the id of a row of another workspace gives no row of this workspace and no foreign row", async () => {
    expect((await rowsOf(await audit(ws, owner, "?limit=1"))).data).toHaveLength(1);
    const answer = await audit(ws, owner, `?cursor=${foreignRowId}`);
    expect(answer.status).toBe(200);
    // An empty page: a foreign id resolves to nothing, never to a seek from another workspace's position.
    expect(await answer.json()).toEqual({ data: [], meta: { next_cursor: null } });
  });

  it("a row carries only the allowlisted fields: no ip digest, no hash, no previous hash", async () => {
    const { data } = await rowsOf(await audit(ws, owner));
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(Object.keys(row).sort()).toEqual([
        "action",
        "actor_kind",
        "actor_ref",
        "at",
        "id",
        "metadata",
        "request_id",
        "resource_id",
        "resource_kind",
      ]);
    }
  });
});
