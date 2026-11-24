import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  unique,
  userIdOf,
} from "../support/tenancy.js";
import { type Fixture, ORIGIN, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
let fx: Fixture;
let ws: string;
let admin: User;
let owner: User;

beforeAll(async () => {
  fx = await startFixture();
  const orgOwner = await signedUser(fx, "act-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, orgOwner.id));
  admin = await signedUser(fx, "act-admin");
  await addWorkspaceMember(fx, ws, admin.id, "admin");
  owner = await signedUser(fx, "act-owner");
  await addWorkspaceMember(fx, ws, owner.id, "owner");
});
afterAll(() => fx.close());

const base = `/api/v1/workspaces`;
const call = (who: User, method: string, path: string, body?: Record<string, unknown>) =>
  fx.request(path, { method, headers: { cookie: who.cookie }, ...(body ? { body } : {}) });
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, string> }).data;
const auditOf = (action: string) =>
  fx.admin(async (client) => {
    const found = await client.query(
      "SELECT actor_kind, actor_ref, resource_id FROM app.audit_logs WHERE workspace_id = $1 AND action = $2",
      [ws, action],
    );
    return found.rows.map((row) => [row.actor_kind, row.actor_ref, row.resource_id]);
  });

describe("invitations", () => {
  it("create answers 201, mails the link to the address and audits invitation.created", async () => {
    const email = `${unique("act")}@example.test`;
    const created = await call(admin, "POST", `${base}/${ws}/invitations`, { email, role_key: "editor" });
    expect(created.status).toBe(201);
    const data = await dataOf(created);
    expect(data).toEqual({ id: expect.any(String), email, role_key: "editor" });
    const [mail] = await fx.mails(email);
    expect([mail?.template, mail?.link.startsWith(`${ORIGIN}/invite/`)]).toEqual(["invitation", true]);
    // The mail names the workspace and the role; it never carries the inviter's address.
    const queued = await fx.admin((client) =>
      client.query("SELECT vars FROM app.email_outbox WHERE recipient = $1", [email]),
    );
    expect(Object.keys(queued.rows[0]?.vars ?? {}).sort()).toEqual(["role", "workspaceName"]);
    expect(await auditOf("invitation.created")).toContainEqual(["user", admin.id, data.id]);
    expect(await (await call(admin, "GET", `${base}/${ws}/invitations`)).text()).toContain(email);
  });

  it("accept answers 200 with the workspace and audits invitation.accepted", async () => {
    const email = `${unique("act")}@example.test`;
    const cookie = await fx.signedIn(email);
    const { id } = await dataOf(
      await call(admin, "POST", `${base}/${ws}/invitations`, { email, role_key: "approver" }),
    );
    const token = String((await fx.mails(email))[0]?.link).split("/invite/")[1];
    const accepted = await call({ id: "", cookie }, "POST", "/api/v1/invitations/accept", { token });
    expect([accepted.status, (await dataOf(accepted)).workspace_id]).toEqual([200, ws]);
    const joined = await userIdOf(fx, email);
    expect(await auditOf("invitation.accepted")).toContainEqual(["user", joined, id]);
  });

  it("revoke answers 200, the row leaves the list and invitation.revoked is audited", async () => {
    const email = `${unique("act")}@example.test`;
    const { id } = await dataOf(
      await call(admin, "POST", `${base}/${ws}/invitations`, { email, role_key: "viewer" }),
    );
    expect((await call(admin, "DELETE", `${base}/${ws}/invitations/${id}`)).status).toBe(200);
    const listed = await (await call(admin, "GET", `${base}/${ws}/invitations`)).text();
    expect(listed).not.toContain(email);
    expect(await auditOf("invitation.revoked")).toContainEqual(["user", admin.id, id]);
  });
});

const seat = async (role: string) => {
  const member = await signedUser(fx, "act-member");
  await addWorkspaceMember(fx, ws, member.id, role);
  return member;
};
const listed = async (query = "") => (await call(admin, "GET", `${base}/${ws}/members${query}`)).json();

describe("members", () => {
  it("the list shows name, role and status, and pages with next_cursor", async () => {
    await seat("editor");
    const page = (await listed("?limit=1")) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(page.data).toHaveLength(1);
    expect(Object.keys(page.data[0] ?? {}).sort()).toEqual(["image", "name", "role", "status", "user_id"]);
    expect(typeof page.meta.next_cursor).toBe("string");
    const rest = (await listed(`?cursor=${page.meta.next_cursor}`)) as { data: unknown[] };
    expect(rest.data.length).toBeGreaterThan(0);
  });

  it.each([
    ["role change", "PATCH", "viewer", { role_key: "approver" }, "member.role_changed"],
    ["remove", "DELETE", "editor", undefined, "member.removed"],
  ])("%s answers 200, changes the list and audits %s", async (_label, method, role, body, action) => {
    const member = await seat(role);
    expect((await call(admin, method, `${base}/${ws}/members/${member.id}`, body)).status).toBe(200);
    const text = JSON.stringify(await listed("?limit=100"));
    expect(text.includes(member.id)).toBe(method === "PATCH");
    expect(await auditOf(action)).toContainEqual(["user", admin.id, member.id]);
  });

  it("leave answers 200, drops the caller from the list and audits member.left", async () => {
    const member = await seat("viewer");
    expect((await call(member, "POST", `${base}/${ws}/members/me/leave`)).status).toBe(200);
    expect(JSON.stringify(await listed("?limit=100"))).not.toContain(member.id);
    expect(await auditOf("member.left")).toContainEqual(["user", member.id, member.id]);
  });

  it("the Owner transfers ownership to an admin, who becomes the Owner, and it is audited", async () => {
    expect(
      (await call(owner, "PATCH", `${base}/${ws}/members/${admin.id}`, { role_key: "owner" })).status,
    ).toBe(200);
    const roles = Object.fromEntries(
      ((await listed("?limit=100")) as { data: Array<{ user_id: string; role: string }> }).data.map((row) => [
        row.user_id,
        row.role,
      ]),
    );
    expect([roles[admin.id], roles[owner.id]]).toEqual(["owner", "admin"]);
    expect(await auditOf("workspace.owner_transferred")).toContainEqual(["user", owner.id, admin.id]);
  });
});
