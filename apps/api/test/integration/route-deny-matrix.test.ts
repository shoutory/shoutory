import { WORKSPACE_ROLES } from "@shoutory/core/authz";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_PATHS } from "../../src/auth/paths.js";
import { defineRoute, registeredRoutes } from "../../src/routes/define-route.js";
import {
  addOrganizationMember,
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  workspacePath,
  workspaceRow,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// E4: roles x actions at request level. A route is reached only through its access declaration; what the caller
// may not see answers 404, what the caller sees but may not do answers 403 (R206, R216).

let fx: Fixture;
let orgId: string;
beforeAll(async () => {
  fx = await startFixture();
  const founder = await signedUser(fx, "matrix-founder");
  orgId = await seedOrganization(fx, founder.id);
});
afterAll(() => fx.close());

const call = (cookie: string, id: string, method: "GET" | "PATCH", body?: unknown) =>
  fx.request(workspacePath(id), { method, headers: { cookie }, ...(body === undefined ? {} : { body }) });
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; requestId: string } }).error;

interface Kind {
  readonly label: string;
  readonly role?: string;
  readonly orgRole?: string;
  readonly suspended?: boolean;
  readonly get: number;
  readonly patch: number;
}
// R175: only Admin and Owner hold settings.manage. An organization owner or admin acts as admin; an organization
// member or billing contact has no workspace access at all.
const KINDS: readonly Kind[] = [
  ...WORKSPACE_ROLES.map((role) => ({
    label: `workspace ${role}`,
    role,
    get: 200,
    patch: role === "owner" || role === "admin" ? 200 : 403,
  })),
  { label: "organization owner", orgRole: "owner", get: 200, patch: 200 },
  { label: "organization admin", orgRole: "admin", get: 200, patch: 200 },
  { label: "organization member", orgRole: "member", get: 404, patch: 404 },
  { label: "organization billing", orgRole: "billing", get: 404, patch: 404 },
  {
    label: "suspended editor who is organization admin",
    role: "editor",
    orgRole: "admin",
    suspended: true,
    get: 200,
    patch: 200,
  },
];

describe("workspace route deny matrix", () => {
  it.each(KINDS)(
    "$label: GET $get, PATCH $patch, and a refused PATCH leaves the row as it was",
    async (kind) => {
      const user = await signedUser(fx, "matrix-user");
      const workspaceId = await seedWorkspace(fx, orgId);
      const before = await workspaceRow(fx, workspaceId);
      if (kind.role)
        await addWorkspaceMember(
          fx,
          workspaceId,
          user.id,
          kind.role,
          kind.suspended ? "suspended" : "active",
        );
      if (kind.orgRole) await addOrganizationMember(fx, orgId, user.id, kind.orgRole);

      expect((await call(user.cookie, workspaceId, "GET")).status).toBe(kind.get);
      const patched = await call(user.cookie, workspaceId, "PATCH", { name: "renamed by the matrix" });
      expect(patched.status).toBe(kind.patch);
      const after = await workspaceRow(fx, workspaceId);
      expect(after.name).toBe(kind.patch === 200 ? "renamed by the matrix" : before.name);
      if (kind.patch === 403) expect((await errorOf(patched)).code).toBe("forbidden");
      if (kind.patch === 404) expect((await errorOf(patched)).code).toBe("not_found");
    },
  );
});

describe("workspace route non-inference and forged ids", () => {
  const setup = async () => {
    const user = await signedUser(fx, "probe");
    const own = await seedWorkspace(fx, orgId);
    await addWorkspaceMember(fx, own, user.id, "owner");
    const otherOrg = await seedOrganization(fx, (await signedUser(fx, "other-founder")).id);
    // A sibling in the caller's own organization, where the caller is neither a member nor an organization owner or admin.
    const sibling = await seedWorkspace(fx, orgId);
    return { user, own, sibling, foreign: await seedWorkspace(fx, otherOrg) };
  };

  it("a foreign, a sibling and a missing workspace answer the same 404 body, while the caller's own answers 200", async () => {
    const { user, own, sibling, foreign } = await setup();
    expect((await call(user.cookie, own, "GET")).status).toBe(200);
    const untouched = [await workspaceRow(fx, foreign), await workspaceRow(fx, sibling)];
    const answers = await Promise.all(
      [foreign, sibling, crypto.randomUUID()].flatMap((id) => [
        call(user.cookie, id, "GET"),
        call(user.cookie, id, "PATCH", { name: "x" }),
      ]),
    );
    const bodies = await Promise.all(
      answers.map((answer) => answer.json() as Promise<{ error: Record<string, unknown> }>),
    );
    for (const answer of answers) expect(answer.status).toBe(404);
    const withoutRequestId = bodies.map((body) => ({ error: { ...body.error, requestId: undefined } }));
    for (const body of withoutRequestId) expect(body).toEqual(withoutRequestId[0]);
    expect(bodies[0]?.error.code).toBe("not_found");
    expect([await workspaceRow(fx, foreign), await workspaceRow(fx, sibling)]).toEqual(untouched);
  });

  it("a forged workspace_id in the query or the body is refused as an unknown key and the other workspace is unchanged", async () => {
    const { user, own, foreign } = await setup();
    const before = await workspaceRow(fx, foreign);
    const inQuery = await fx.request(`${workspacePath(own)}?workspace_id=${foreign}`, {
      headers: { cookie: user.cookie },
    });
    const inBody = await call(user.cookie, own, "PATCH", { name: "forged", workspace_id: foreign });
    for (const answer of [inQuery, inBody]) {
      expect(answer.status).toBe(400);
      expect((await errorOf(answer)).code).toBe("validation_failed");
    }
    expect(await workspaceRow(fx, foreign)).toEqual(before);
    expect((await workspaceRow(fx, own)).name).not.toBe("forged");
  });
});

describe("user routes", () => {
  it("a signed-in user route runs with no scope, no transaction and no app-pool connection", async () => {
    const user = await signedUser(fx, "user-route");
    // A route cannot be added to an app that has served a request, so this one gets a fresh app.
    const app = fx.appOn(fx.db.url("auth"));
    defineRoute(app, {
      method: "get",
      path: "/test/user-route",
      policy: "session",
      access: "user",
      handler: ({ tx, scope }) => ({ tx: tx ?? null, scope: scope ?? null }),
    });
    const connect = vi.spyOn(fx.db.pool("app"), "connect");
    const answer = await fx.request("/test/user-route", { headers: { cookie: user.cookie } }, app);
    const touched = connect.mock.calls.length;
    connect.mockRestore();
    expect(await answer.json()).toEqual({ data: { tx: null, scope: null } });
    expect(touched).toBe(0);
  });
});

describe("route table", () => {
  it("the workspace routes declare their access", () => {
    const routes = registeredRoutes(fx.app);
    const find = (method: string) =>
      routes.find((r) => r.method === method && r.path === "/api/v1/workspaces/:workspace_id");
    expect(find("GET")?.access).toEqual({ workspace: "workspace_id" });
    expect(find("PATCH")?.access).toEqual({ workspace: "workspace_id", permission: "settings.manage" });
  });

  it("an unregistered route and an unregistered method are refused before any handler or database connection", async () => {
    const user = await signedUser(fx, "unregistered");
    const owned = await seedWorkspace(fx, orgId);
    await addWorkspaceMember(fx, owned, user.id, "owner");
    const connect = vi.spyOn(fx.db.pool("app"), "connect");
    const unknown = await fx.request(`${workspacePath(owned)}/nothing-here`, {
      headers: { cookie: user.cookie },
    });
    const wrongMethod = await fx.request(workspacePath(owned), {
      method: "DELETE",
      headers: { cookie: user.cookie },
    });
    const noSession = await Promise.all([
      fx.request(workspacePath(owned)),
      fx.request(workspacePath(owned), { method: "PATCH", body: { name: "no session" } }),
    ]);
    const touched = connect.mock.calls.length;
    connect.mockRestore();
    for (const answer of noSession) {
      expect(answer.status).toBe(401);
      expect((await errorOf(answer)).code).toBe("unauthenticated");
    }
    expect((await workspaceRow(fx, owned)).name).not.toBe("no session");
    expect(unknown.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
    expect(touched).toBe(0);
    // The control: the registered route does reach the database, so the spy can see a connection.
    const spy = vi.spyOn(fx.db.pool("app"), "connect");
    expect((await call(user.cookie, owned, "GET")).status).toBe(200);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("a session path of the authentication mount answers 401 with no cookie", async () => {
    for (const row of AUTH_PATHS.filter((r) => r.method === "GET" && r.policy !== "public")) {
      expect((await fx.request(row.path)).status, row.path).toBe(401);
    }
  });
});

describe("workspace limit", () => {
  it("a caller who reaches 501 workspaces gets 409 limit_reached on a workspace route, never 500", async () => {
    const owner = await signedUser(fx, "limit-owner");
    const member = await signedUser(fx, "limit-member");
    const bulkOrg = await seedOrganization(fx, owner.id);
    const first = await fx.admin(async (client) => {
      await client.query(
        `WITH made AS (
           INSERT INTO app.workspaces (organization_id, name, slug)
           SELECT $1, 'bulk ' || g, 'bulk-' || g FROM generate_series(1, 501) AS g RETURNING id)
         INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
         SELECT made.id, $2, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'viewer') FROM made`,
        [bulkOrg, member.id],
      );
      return (
        await client.query("SELECT id FROM app.workspaces WHERE organization_id = $1 LIMIT 1", [bulkOrg])
      ).rows[0].id;
    });
    const answer = await call(member.cookie, first, "GET");
    expect(answer.status).toBe(409);
    expect((await errorOf(answer)).code).toBe("limit_reached");
    expect(answer.headers.get("retry-after")).toBeNull();
  });
});
