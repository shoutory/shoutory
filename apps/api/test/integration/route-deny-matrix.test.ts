import { createHmac } from "node:crypto";
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
  unique,
  workspacePath,
  workspaceRow,
} from "../support/tenancy.js";
import { type Fixture, PEPPER, SAMPLE, startFixture } from "./auth/harness.js";

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
// Only Admin and Owner hold settings.manage. An organization owner or admin acts as admin; an organization
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

  it.each([
    ["42501", "my_workspaces refuses this caller", 404, "not_found"],
    ["22023", "workspace_create: unknown time zone", 400, "validation_failed"],
    ["54000", "resolve_workspace_access: more than 500 reachable workspaces", 409, "limit_reached"],
    ["53400", "organization_create: at most 20 owned organizations", 409, "limit_reached"],
    ["22012", "my_workspaces refuses this caller", 500, "internal_error"],
    ["42501", "permission denied for table workspaces", 500, "internal_error"],
    ["42501", "my_workspaces_other refuses this caller", 500, "internal_error"],
  ])(
    "inUserTx maps state %s with the message %j to %i %s; any other state or message stays an internal error",
    async (state, message, status, code) => {
      const user = await signedUser(fx, "user-tx-map");
      const app = fx.appOn(fx.db.url("auth"));
      defineRoute(app, {
        method: "get",
        path: "/test/user-tx",
        policy: "session",
        access: "user",
        handler: ({ inUserTx }) =>
          inUserTx((tx) =>
            tx.query(`DO $$ BEGIN RAISE EXCEPTION '${message}' USING ERRCODE = '${state}'; END $$`),
          ),
      });
      const answer = await fx.request("/test/user-tx", { headers: { cookie: user.cookie } }, app);
      expect(answer.status).toBe(status);
      expect((await errorOf(answer)).code).toBe(code);
    },
  );
});

const POSTS = "/api/v1/workspaces/:workspace_id/posts";
const WANTED: [string, string, string][] = [
  ["POST", POSTS, "posts.edit"],
  ["GET", `${POSTS}/:post_id`, "posts.view"],
  ["PATCH", `${POSTS}/:post_id`, "posts.edit"],
  ["POST", `${POSTS}/:post_id/save`, "posts.edit"],
  ["GET", `${POSTS}/:post_id/versions`, "posts.view"],
  ["POST", `${POSTS}/:post_id/versions/:version_id/restore`, "posts.edit"],
];

describe("posts route table", () => {
  it("the six posts routes declare posts.view for reads and posts.edit for writes", () => {
    const routes = registeredRoutes(fx.app);
    for (const [method, path, permission] of WANTED) {
      const found = routes.find((r) => r.method === method && r.path === path);
      expect(found?.access, `${method} ${path}`).toEqual({ workspace: "workspace_id", permission });
      expect(found?.policy).toBe("session");
    }
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

  it("only the unsubscribe route opts out of the web-client CSRF check, and it is a public POST", () => {
    const optedOut = registeredRoutes(fx.app).filter((route) => route.csrf === "token");
    expect(optedOut.map((r) => `${r.method} ${r.path} ${r.policy}`)).toEqual([
      "POST /api/v1/unsubscribe/:token public",
    ]);
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
});

const bodyOf = (row: (typeof AUTH_PATHS)[number]) => (row.method === "GET" ? undefined : SAMPLE[row.path]);
const GUARDED = AUTH_PATHS.filter((row) => row.policy !== "public");
// The public rows are the ones a person reaches before any session exists.
const PUBLIC = [
  "/api/auth/send-verification-email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/verify-email",
];

const STEP_UP = [
  "/api/auth/change-password",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/generate-backup-codes",
  "/api/auth/two-factor/get-totp-uri",
];

describe("every authentication path is checked by its policy", () => {
  it.each(GUARDED.map((row) => [row.method, row.path, row.policy]))(
    "%s %s (%s) answers 401 with no cookie",
    async (method, path) => {
      const row = AUTH_PATHS.find((candidate) => candidate.path === path && candidate.method === method);
      const body = row === undefined ? undefined : bodyOf(row);
      expect(row?.method === "GET" || body !== undefined, `add a sample body for ${path}`).toBe(true);
      const answer = await fx.request(String(path), { method: String(method), ...(body ? { body } : {}) });
      expect(answer.status).toBe(401);
    },
  );

  it.each(GUARDED.filter((row) => row.policy === "step_up").map((row) => [row.method, row.path]))(
    "%s %s answers 403 step_up_required once the step-up is stale",
    async (method, path) => {
      const email = `stale-${String(path).replaceAll("/", "-")}@example.test`.replace("--", "-");
      const cookie = await fx.signedIn(email);
      await fx.admin((client) =>
        client.query(
          `UPDATE app.session_step_ups SET at = at - interval '11 minutes'
            WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
          [email],
        ),
      );
      const answer = await fx.request(String(path), {
        method: String(method),
        headers: { cookie },
        body: SAMPLE[String(path)],
      });
      expect([answer.status, (await errorOf(answer)).code]).toEqual([403, "step_up_required"]);
    },
  );

  it("the public rows and the step-up rows are exactly the explicit lists", () => {
    const pathsOf = (policy: string) =>
      AUTH_PATHS.filter((row) => row.policy === policy)
        .map((row) => row.path)
        .sort();
    expect(pathsOf("public")).toEqual([...PUBLIC].sort());
    expect(pathsOf("step_up")).toEqual([...STEP_UP].sort());
  });
});

const ORGS = "/api/v1/organizations";
const WORKSPACES = "/api/v1/workspaces";
const post = (cookie: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fx.request(path, { method: "POST", headers: { cookie, ...headers }, body });
const list = async (cookie: string, path: string, query = "") => {
  const answer = await fx.request(`${path}${query}`, { headers: { cookie } });
  return { status: answer.status, body: (await answer.json()) as { data?: Array<Record<string, string>> } };
};
const countWhere = (table: string, name: string) =>
  fx.admin(async (client) =>
    Number((await client.query(`SELECT count(*) AS n FROM app.${table} WHERE name = $1`, [name])).rows[0].n),
  );
const newWorkspace = (organization_id: string, name: string) => ({
  organization_id,
  name,
  default_tz: "UTC",
});
// The control that makes a refusal mean something: the same caller creates in an organization it owns (201), so a 404
// below is the definer's refusal and not a missing route.
async function expectCanCreateInOwnOrganization(user: { id: string; cookie: string }) {
  const own = await seedOrganization(fx, user.id);
  expect((await post(user.cookie, WORKSPACES, newWorkspace(own, unique("control")))).status).toBe(201);
}

describe("POST /workspaces: who may create", () => {
  it.each([
    { label: "foreign organization", pick: "foreign" },
    { label: "missing organization", pick: "missing" },
    { label: "organization member only", pick: "member" },
    { label: "organization billing contact", pick: "billing" },
  ])("$label: the same 404 body as a missing one, and nothing is written", async ({ pick }) => {
    const user = await signedUser(fx, "create-denied");
    const founder = await signedUser(fx, "create-founder");
    const ids: Record<string, string> = {
      foreign: await seedOrganization(fx, founder.id),
      missing: crypto.randomUUID(),
      member: await seedOrganization(fx, founder.id),
      billing: await seedOrganization(fx, founder.id),
    };
    await addOrganizationMember(fx, ids.member as string, user.id, "member");
    await addOrganizationMember(fx, ids.billing as string, user.id, "billing");
    await expectCanCreateInOwnOrganization(user);
    const name = unique("denied-create");
    const answer = await post(user.cookie, WORKSPACES, newWorkspace(ids[pick] as string, name));
    const reference = await post(user.cookie, WORKSPACES, newWorkspace(crypto.randomUUID(), name));
    expect(answer.status).toBe(404);
    expect(reference.status).toBe(404);
    const [a, b] = [await errorOf(answer), await errorOf(reference)];
    expect({ ...a, requestId: undefined }).toEqual({ ...b, requestId: undefined });
    expect(a.code).toBe("not_found");
    expect(await countWhere("workspaces", name)).toBe(0);
  });

  it.each([
    { label: "organization owner", orgRole: "owner", status: 201 },
    { label: "organization admin", orgRole: "admin", status: 201 },
    { label: "ordinary workspace admin without an organization role", role: "admin", status: 404 },
    {
      label: "suspended workspace owner without an organization role",
      role: "owner",
      suspended: true,
      status: 404,
    },
  ])("$label gets $status and the creator is the stored owner only on 201", async (kind) => {
    const user = await signedUser(fx, "creator");
    const org = await seedOrganization(fx, (await signedUser(fx, "creator-founder")).id);
    if (kind.orgRole) await addOrganizationMember(fx, org, user.id, kind.orgRole);
    if (kind.role) {
      const existing = await seedWorkspace(fx, org);
      await addWorkspaceMember(fx, existing, user.id, kind.role, kind.suspended ? "suspended" : "active");
    }
    if (kind.status === 404) await expectCanCreateInOwnOrganization(user);
    const name = unique("creator-ws");
    const answer = await post(user.cookie, WORKSPACES, newWorkspace(org, name));
    expect(answer.status).toBe(kind.status);
    const owners = await fx.admin(
      async (client) =>
        (
          await client.query(
            `SELECT count(*)::int AS n FROM app.workspace_members m JOIN app.workspaces w ON w.id = m.workspace_id
             JOIN app.roles r ON r.id = m.role_id WHERE w.name = $1 AND m.user_id = $2 AND r.key = 'owner'`,
            [name, user.id],
          )
        ).rows[0].n,
    );
    expect(owners).toBe(kind.status === 201 ? 1 : 0);
    expect(await countWhere("workspaces", name)).toBe(kind.status === 201 ? 1 : 0);
  });
});

describe("organization and workspace lists show only the caller's rows", () => {
  it("an organization-only member sees the organization and no workspaces; an implicit admin sees the workspaces", async () => {
    const org = await seedOrganization(fx, (await signedUser(fx, "list-founder")).id);
    const workspace = await seedWorkspace(fx, org);
    const member = await signedUser(fx, "list-member");
    const admin = await signedUser(fx, "list-admin");
    await addOrganizationMember(fx, org, member.id, "member");
    await addOrganizationMember(fx, org, admin.id, "admin");
    const memberOrgs = (await list(member.cookie, ORGS)).body.data?.map((row) => row.id);
    const memberSpaces = await list(member.cookie, WORKSPACES);
    const adminSpaces = (await list(admin.cookie, WORKSPACES)).body.data?.map((row) => row.id);
    expect(memberOrgs).toEqual([org]);
    expect(memberSpaces).toEqual({ status: 200, body: { data: [], meta: { next_cursor: null } } });
    expect(adminSpaces).toEqual([workspace]);
  });

  it("a suspended member is excluded, and a foreign cursor leaks nothing", async () => {
    const org = await seedOrganization(fx, (await signedUser(fx, "list2-founder")).id);
    const otherOrg = await seedOrganization(fx, (await signedUser(fx, "list2-other")).id);
    const foreign = await seedWorkspace(fx, otherOrg);
    const user = await signedUser(fx, "list2-user");
    const suspended = await seedWorkspace(fx, org);
    const active = await seedWorkspace(fx, org);
    await addWorkspaceMember(fx, suspended, user.id, "editor", "suspended");
    await addWorkspaceMember(fx, active, user.id, "editor");
    expect((await list(user.cookie, WORKSPACES)).body.data?.map((row) => row.id)).toEqual([active]);
    const afterForeign = await list(user.cookie, WORKSPACES, `?cursor=${foreign}&limit=100`);
    expect(afterForeign.status).toBe(200);
    expect(JSON.stringify(afterForeign.body)).not.toContain(foreign);
  });
});

describe("forged keys in the create bodies", () => {
  const FORGED = ["slug", "org_role", "role_id", "organization_id", "workspace_id", "user_id", "owner"];
  it.each(FORGED)("organization body with %s is refused 400 and nothing is written", async (key) => {
    const user = await signedUser(fx, "forge-org");
    const name = unique("forged-org");
    const answer = await post(user.cookie, ORGS, { name, type: "team", [key]: crypto.randomUUID() });
    expect(answer.status).toBe(400);
    expect((await errorOf(answer)).code).toBe("validation_failed");
    expect(await countWhere("organizations", name)).toBe(0);
  });

  it.each(FORGED.filter((key) => key !== "organization_id"))(
    "workspace body with %s is refused 400 and nothing is written",
    async (key) => {
      const user = await signedUser(fx, "forge-ws");
      const org = await seedOrganization(fx, user.id);
      const name = unique("forged-ws");
      const forged = key === "slug" ? "Not A Slug!" : crypto.randomUUID();
      const answer = await post(user.cookie, WORKSPACES, { ...newWorkspace(org, name), [key]: forged });
      expect(answer.status).toBe(400);
      expect(await countWhere("workspaces", name)).toBe(0);
    },
  );

  it.each([ORGS, WORKSPACES])("organization_id in the %s list query is refused 400", async (path) => {
    const user = await signedUser(fx, "forge-query");
    const answer = await fx.request(`${path}?organization_id=${crypto.randomUUID()}`, {
      headers: { cookie: user.cookie },
    });
    expect(answer.status).toBe(400);
  });
});

describe("create limits", () => {
  it("the 21st owned organization gets 409 limit_reached and rolls back", async () => {
    const user = await signedUser(fx, "org-limit");
    const tag = unique("l");
    await fx.admin((client) =>
      client.query(
        `WITH made AS (INSERT INTO app.organizations (name, slug, type)
           SELECT 'limit ' || g, 'limit-' || g || '-' || $1, 'team' FROM generate_series(1, 20) AS g RETURNING id)
         INSERT INTO app.organization_members (organization_id, user_id, org_role)
         SELECT id, $2, 'owner' FROM made`,
        [tag, user.id],
      ),
    );
    const name = unique("one-too-many");
    const answer = await post(user.cookie, ORGS, { name, type: "team" });
    expect(answer.status).toBe(409);
    expect((await errorOf(answer)).code).toBe("limit_reached");
    expect(await countWhere("organizations", name)).toBe(0);
  });

  // One seed of 501 reachable workspaces serves both rows.
  let bulk: Promise<{ cookie: string; first: string }> | undefined;
  const seedBulk = () => {
    bulk ??= (async () => {
      const owner = await signedUser(fx, "limit-owner");
      const member = await signedUser(fx, "limit-member");
      const bulkOrg = await seedOrganization(fx, owner.id);
      const first = await fx.admin(async (client) => {
        await client.query(
          `WITH made AS (
             INSERT INTO app.workspaces (organization_id, name, slug)
             SELECT $1, 'bulk ' || g, 'bulk-' || g FROM generate_series(1, 501) AS g RETURNING id)
           INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
           SELECT made.id, m.u::uuid, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = m.k)
           FROM made CROSS JOIN (VALUES ($2, 'viewer'), ($3, 'owner')) AS m (u, k)`,
          [bulkOrg, member.id, owner.id],
        );
        return (
          await client.query("SELECT id FROM app.workspaces WHERE organization_id = $1 LIMIT 1", [bulkOrg])
        ).rows[0].id;
      });
      return { cookie: member.cookie, first };
    })();
    return bulk;
  };

  it.each([
    ["a workspace route", (cookie: string, first: string) => call(cookie, first, "GET")],
    ["GET /workspaces", (cookie: string) => fx.request(WORKSPACES, { headers: { cookie } })],
  ])("a caller who reaches 501 workspaces gets 409 limit_reached on %s, never 500", async (_label, send) => {
    const { cookie, first } = await seedBulk();
    const answer = await send(cookie, first);
    expect(answer.status).toBe(409);
    expect((await errorOf(answer)).code).toBe("limit_reached");
    expect(answer.headers.get("retry-after")).toBeNull();
  });
});

describe("CSRF, sessions and audit on the new routes", () => {
  it.each([ORGS, WORKSPACES])("a foreign Origin on POST %s gets 403 and writes nothing", async (path) => {
    const user = await signedUser(fx, "csrf-user");
    const org = await seedOrganization(fx, user.id);
    const name = unique("csrf");
    const body = path === ORGS ? { name, type: "team" } : newWorkspace(org, name);
    const answer = await post(user.cookie, path, body, {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(answer.status).toBe(403);
    expect([await countWhere("organizations", name), await countWhere("workspaces", name)]).toEqual([0, 0]);
  });

  it.each([
    ["GET", ORGS],
    ["GET", WORKSPACES],
    ["POST", ORGS],
    ["POST", WORKSPACES],
  ])("%s %s with no session answers 401", async (method, path) => {
    const body = path === ORGS ? { name: "x", type: "team" } : newWorkspace(crypto.randomUUID(), "x");
    const answer = await fx.request(path, { method, ...(method === "POST" ? { body } : {}) });
    expect(answer.status).toBe(401);
    expect((await errorOf(answer)).code).toBe("unauthenticated");
  });

  it("the audit row carries the X-Request-Id and a non-null ip_hmac that is not the raw address", async () => {
    const user = await signedUser(fx, "audit-user");
    const peer = "192.0.2.77";
    const answer = await fx.request(ORGS, {
      method: "POST",
      headers: { cookie: user.cookie },
      body: { name: unique("audited"), type: "agency" },
      peer,
    });
    expect(answer.status).toBe(201);
    const id = ((await answer.json()) as { data: { id: string } }).data.id;
    const row = await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT request_id, ip_hmac FROM app.audit_logs WHERE resource_kind = 'organization' AND resource_id = $1",
            [id],
          )
        ).rows[0],
    );
    expect(row.request_id).toBe(answer.headers.get("x-request-id"));
    expect(row.ip_hmac).not.toBeNull();
    expect(Buffer.from(row.ip_hmac).equals(Buffer.from(peer))).toBe(false);
    // An independent computation of the `audit_ip` digest over the fixture's pepper.
    const expected = createHmac("sha256", Buffer.from(PEPPER)).update(`audit_ip:${peer}`).digest();
    expect(Buffer.from(row.ip_hmac).equals(expected)).toBe(true);
  });
});
