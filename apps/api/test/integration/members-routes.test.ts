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
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};

const base = (id: string) => `/api/v1/workspaces/${id}`;
const MISSING = "019a0000-0000-7000-8000-000000000000";
const SEATS = ["owner", "admin", "admin2", "editor", "approver", "viewer"] as const;
const ROLES: Record<(typeof SEATS)[number], string> = {
  owner: "owner",
  admin: "admin",
  admin2: "admin",
  editor: "editor",
  approver: "approver",
  viewer: "viewer",
};

beforeAll(async () => {
  fx = await startFixture();
  const orgOwner = await signedUser(fx, "mem-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, orgOwner.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `mem-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, ROLES[seat]);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());

const call = (who: User, method: string, path: string, body?: Record<string, unknown>) =>
  fx.request(path, { method, headers: { cookie: who.cookie }, ...(body ? { body } : {}) });
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string; details?: { reason?: string } } };
  return [answer.status, error.code, error.details?.reason];
};
const ageStepUp = (who: User, interval: string) =>
  fx.admin((client) =>
    client.query("UPDATE app.session_step_ups SET at = clock_timestamp() - $2::interval WHERE user_id = $1", [
      who.id,
      interval,
    ]),
  );

describe("who may list members and invitations", () => {
  it.each(["editor", "approver", "viewer"])(
    "a %s gets 403 forbidden on both lists and on create",
    async (role) => {
      const create = { email: `${unique("nope")}@example.test`, role_key: "viewer" };
      const answers = await Promise.all([
        call(user(role), "GET", `${base(ws)}/members`),
        call(user(role), "GET", `${base(ws)}/invitations`),
        call(user(role), "POST", `${base(ws)}/invitations`, create),
      ]);
      expect(await Promise.all(answers.map(errorOf))).toEqual(Array(3).fill([403, "forbidden", undefined]));
    },
  );

  it("a non-member of an existing workspace gets the identical 404 as for a missing one", async () => {
    for (const path of ["members", "invitations"]) {
      expect((await call(user("admin"), "GET", `${base(ws)}/${path}`)).status).toBe(200);
      const real = await call(user("outsider"), "GET", `${base(ws)}/${path}`);
      const missing = await call(user("outsider"), "GET", `${base(MISSING)}/${path}`);
      expect(real.status).toBe(404);
      expect(await errorOf(real)).toEqual(await errorOf(missing));
    }
  });

  it("an admin's list holds this workspace's members only and never a token digest", async () => {
    const mine = await (await call(user("admin"), "GET", `${base(ws)}/members`)).text();
    expect(mine).toContain(user("owner").id);
    expect(mine).not.toContain(user("foreign").id);
    expect(mine).not.toContain("token_hash");
    const foreign = await (await call(user("foreign"), "GET", `${base(other)}/members`)).text();
    expect(foreign).not.toContain(user("owner").id);
  });
});

describe("a definer refusal keeps its own status", () => {
  // caller, target, method, body, status, code
  it.each([
    ["admin changes the Owner: SH403", "admin", "owner", "PATCH", { role_key: "viewer" }, 403, "forbidden"],
    ["admin removes a peer: SH403", "admin", "admin2", "DELETE", undefined, 403, "forbidden"],
    ["admin makes an Owner: SH403", "admin", "editor", "PATCH", { role_key: "owner" }, 403, "forbidden"],
    ["Owner demotes self: SH409", "owner", "owner", "PATCH", { role_key: "admin" }, 409, "conflict"],
    ["remove route on self: 409", "owner", "owner", "DELETE", undefined, 409, "conflict"],
  ])("%s", async (_label, caller, target, method, body, status, code) => {
    const answer = await call(user(caller), method, `${base(ws)}/members/${user(target).id}`, body);
    expect([answer.status, (await errorOf(answer))[1]]).toEqual([status, code]);
  });

  const EDITOR = () => user("editor").id;
  it.each([
    ["role change", "PATCH", (id: string) => `${base(id)}/members/${EDITOR()}`, { role_key: "viewer" }],
    ["remove", "DELETE", (id: string) => `${base(id)}/members/${EDITOR()}`, undefined],
    ["leave", "POST", (id: string) => `${base(id)}/members/me/leave`, undefined],
  ])("%s: a foreign and a missing workspace answer the identical 404", async (_l, method, path, body) => {
    const admin = user("admin");
    // The route exists: a malformed workspace id is a 400 before any access.
    expect((await call(admin, method, path("not-a-uuid"), body)).status).toBe(400);
    const foreign = await call(admin, method, path(other), body);
    const missing = await call(admin, method, path(MISSING), body);
    expect(foreign.status).toBe(404);
    expect(await errorOf(foreign)).toEqual(await errorOf(missing));
  });
});

describe("step-up on member changes", () => {
  it("a role change and a removal after 11 minutes give 403 step_up_required; leaving needs none", async () => {
    const [admin, viewer] = [user("admin"), user("viewer")];
    const leaver = await signedUser(fx, "mem-leaver");
    await addWorkspaceMember(fx, ws, leaver.id, "viewer");
    await ageStepUp(admin, "11 minutes");
    await ageStepUp(leaver, "11 minutes");
    const stale = await Promise.all([
      call(admin, "PATCH", `${base(ws)}/members/${viewer.id}`, { role_key: "editor" }),
      call(admin, "DELETE", `${base(ws)}/members/${viewer.id}`),
    ]);
    expect(await Promise.all(stale.map(errorOf))).toEqual(
      Array(2).fill([403, "step_up_required", undefined]),
    );
    expect((await call(leaver, "POST", `${base(ws)}/members/me/leave`)).status).toBe(200);
    // Inviting and revoking need no step-up either.
    const email = `${unique("stale")}@example.test`;
    const created = await call(admin, "POST", `${base(ws)}/invitations`, { email, role_key: "viewer" });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    expect((await call(admin, "DELETE", `${base(ws)}/invitations/${data.id}`)).status).toBe(200);
  });

  it("the same changes pass within 9 minutes", async () => {
    const [admin, viewer] = [user("admin"), user("viewer")];
    await ageStepUp(admin, "9 minutes");
    const change = await call(admin, "PATCH", `${base(ws)}/members/${viewer.id}`, { role_key: "approver" });
    expect(change.status).toBe(200);
    expect((await call(admin, "DELETE", `${base(ws)}/members/${viewer.id}`)).status).toBe(200);
  });
});
