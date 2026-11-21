import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type TenantCtx, withTenant } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { HASH_BAD, holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// The access definers of migration 0009: the only read and create paths of the tenancy tables. A caller is always
// the signed-in user of the session context; no workspace list or write workspace in that context changes a result.
type Rows = Record<string, unknown>[];
interface Fixture {
  db: () => TestDatabase;
  rows: (sql: string, params?: unknown[]) => Promise<Rows>;
  app: () => Pool;
}

/** One clone, seeded as the superuser. */
function useDatabase(seed: (admin: Client) => Promise<void>): Fixture {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await withAdminClient(env, db.name, seed);
  });
  afterAll(() => db.drop());
  const rows = (sql: string, params?: unknown[]) =>
    withAdminClient(env, db.name, async (a) => (await a.query(sql, params)).rows);
  return { db: () => db, rows, app: () => db.pool("app") };
}

const asUser = (id: string): TenantCtx => ({ principalKind: "user", principalId: id });
const run = (t: Fixture, ctx: TenantCtx, sql: string, params: unknown[] = []) =>
  withTenant(t.app(), ctx, (tx) => tx.query(sql, params)).then((result) => result.rows as Rows);
const byId = (key: string) => (a: Record<string, unknown>, b: Record<string, unknown>) =>
  String(a[key]).localeCompare(String(b[key]));
const addUser = (id: string, label: string, image: string | null = null) =>
  `INSERT INTO auth."user" (id, name, email, image) VALUES ('${id}', '${label}', '${label}@example.test', ${
    image === null ? "NULL" : `'${image}'`
  })`;

const COUNTS = `SELECT (SELECT count(*)::int FROM app.organizations) AS organizations,
  (SELECT count(*)::int FROM app.organization_members) AS organization_members,
  (SELECT count(*)::int FROM app.workspaces) AS workspaces,
  (SELECT count(*)::int FROM app.workspace_members) AS workspace_members,
  (SELECT count(*)::int FROM app.audit_logs) AS audit_logs`;
const NOTHING = {
  organizations: 0,
  organization_members: 0,
  workspaces: 0,
  workspace_members: 0,
  audit_logs: 0,
};

interface Footprint {
  /** The change in the row counts of the tenancy and audit tables that `act` leaves behind. */
  delta: Record<string, number>;
  /** What `act` threw, or undefined: the caller asserts the outcome it expects. */
  error: unknown;
  value: unknown;
}

/** Runs `act` once and measures what it left behind; the error is reported, never discarded. */
async function footprint(t: Fixture, act: () => Promise<unknown>): Promise<Footprint> {
  const before = (await t.rows(COUNTS))[0] as Record<string, number>;
  let error: unknown;
  let value: unknown;
  try {
    value = await act();
  } catch (caught) {
    error = caught;
  }
  const after = (await t.rows(COUNTS))[0] as Record<string, number>;
  const delta = Object.fromEntries(
    Object.keys(before).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
  return { delta, error, value };
}

/** Calls the definer, reads the new row back through `seen` in the same transaction, then rolls back. */
async function createThenRollBack(
  t: Fixture,
  user: string,
  create: [string, unknown[]],
  seen: string,
): Promise<number> {
  const client = await openTx(t.app(), asUser(user));
  try {
    const id = (await client.query(...create)).rows[0].id as string;
    return (await client.query(seen, [id])).rows[0].n as number;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// ---- R196: the caller must be a signed-in user ------------------------------------------------------------------

const U1 = randomUUID();
const UM = randomUUID();
const US = randomUUID();
const UN = randomUUID();
const UD = randomUUID();
const UB = randomUUID();
const UO = randomUUID();
const UX = randomUUID();
const UOA = randomUUID();
const OA = randomUUID();
const OB = randomUUID();
const OE = randomUUID();
const WA1 = randomUUID();
const WA2 = randomUUID();
const WB = randomUUID();

/**
 * OA: UOA owner (no workspace row); U1 member; UM admin (and stored viewer in WA1); US member (stored, suspended editor in WA1); UN admin (stored,
 * suspended in WA1); UD admin (no stored row). WA2 has U1 as stored editor. UOA is also the suspended stored Owner of
 * WA1 and WA2 (the Owner guard wants one; a suspended row reaches nothing). OB holds UB alone. OE has no workspace.
 */
async function seedAccess(admin: Client): Promise<void> {
  await admin.query(
    [
      addUser(U1, "access-u1", "u1.png"),
      addUser(UM, "access-um", "um.png"),
      addUser(US, "access-us"),
      addUser(UN, "access-un"),
      addUser(UD, "access-ud"),
      addUser(UB, "access-ub"),
      addUser(UO, "access-uo"),
      addUser(UX, "access-ux"),
      addUser(UOA, "access-uoa"),
    ].join(";"),
  );
  await admin.query(
    `INSERT INTO app.organizations (id, name, slug, type) VALUES
       ('${OA}', 'org-a', 'org-a', 'team'), ('${OB}', 'org-b', 'org-b', 'agency'), ('${OE}', 'org-e', 'org-e', 'personal');
     INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES
       ('${OA}', '${U1}', 'member'), ('${OA}', '${UM}', 'admin'), ('${OA}', '${US}', 'member'),
       ('${OA}', '${UN}', 'admin'), ('${OA}', '${UD}', 'admin'), ('${OA}', '${UOA}', 'owner'), ('${OB}', '${UB}', 'owner'),
       ('${OE}', '${UO}', 'owner'), ('${OE}', '${U1}', 'member');
     INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES
       ('${WA1}', '${OA}', 'ws-a1', 'ws-a1'), ('${WA2}', '${OA}', 'ws-a2', 'ws-a2'), ('${WB}', '${OB}', 'ws-b', 'ws-b');
     INSERT INTO app.workspace_members (workspace_id, user_id, role_id, status)
       SELECT m.ws::uuid, m.u::uuid, r.id, m.st FROM (VALUES
         ('${WA1}', '${U1}', 'viewer', 'active'), ('${WA1}', '${UM}', 'viewer', 'active'),
         ('${WA1}', '${US}', 'editor', 'suspended'), ('${WA1}', '${UN}', 'editor', 'suspended'),
         ('${WA2}', '${U1}', 'editor', 'active'), ('${WB}', '${UB}', 'owner', 'active'),
         ('${WA1}', '${UOA}', 'owner', 'suspended'), ('${WA2}', '${UOA}', 'owner', 'suspended')) AS m (ws, u, k, st)
       JOIN app.roles r ON r.key = m.k AND r.workspace_id IS NULL`,
  );
}

// A creation call spends a tenant_create token; a fresh key per call keeps these tests off each other's bucket.
const FRESH_KEY = "encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex')";
const CALLS: [string, string, unknown[]][] = [
  ["resolve_workspace_access", "SELECT * FROM app.resolve_workspace_access()", []],
  ["my_workspaces", "SELECT * FROM app.my_workspaces(10, NULL)", []],
  ["my_organizations", "SELECT * FROM app.my_organizations(10, NULL)", []],
  [
    "workspace_create",
    `SELECT app.workspace_create($1::uuid, 'n', 'slug-x', 'UTC', NULL, NULL, ${FRESH_KEY})`,
    [OA],
  ],
  ["organization_create", `SELECT app.organization_create('n', 'team', NULL, NULL, ${FRESH_KEY})`, []],
  ["member_directory", "SELECT * FROM app.member_directory($1::uuid, 10, NULL)", [WA1]],
];
const NOT_A_USER: [string, TenantCtx][] = [
  ["a service principal", { principalKind: "service", serviceKind: "api_key", principalId: U1 }],
  ["a job principal", { principalKind: "job", principalId: U1, jobPurpose: "x" }],
  ["a portal principal", { principalKind: "portal", principalId: U1, portalGrantId: randomUUID() }],
  ["no principal", {}],
  ["a user kind with no id", { principalKind: "user" }],
];

describe("every access definer refuses a caller that is not a signed-in user (R196)", () => {
  const t = useDatabase(seedAccess);

  it.each(
    CALLS.flatMap(([name, sql, params]) =>
      NOT_A_USER.map(([who, ctx]) => [name, who, ctx, sql, params] as const),
    ),
  )("%s refuses %s with 42501", async (_name, _who, ctx, sql, params) => {
    await expect(run(t, ctx, sql, [...params])).rejects.toMatchObject({ code: "42501" });
  });
});

// ---- resolve_workspace_access, my_workspaces, my_organizations ------------------------------------------------------

describe("resolve_workspace_access (R197)", () => {
  const t = useDatabase(seedAccess);
  const resolve = (user: string, ctx: Partial<TenantCtx> = {}) =>
    run(
      t,
      { ...asUser(user), ...ctx },
      "SELECT workspace_id, organization_id, role_key FROM app.resolve_workspace_access()",
    );
  const row = (workspace: string, organization: string, role: string) => ({
    workspace_id: workspace,
    organization_id: organization,
    role_key: role,
  });

  it("returns the workspaces of a member although the caller cannot select them directly", async () => {
    const direct = await run(t, asUser(U1), "SELECT id FROM app.workspaces");
    expect(direct).toEqual([]);
    expect((await resolve(U1)).sort(byId("workspace_id"))).toEqual(
      [row(WA1, OA, "viewer"), row(WA2, OA, "editor")].sort(byId("workspace_id")),
    );
  });

  // One row per workspace, the higher of the stored and the implicit organization role; a suspended member has
  // access only through the implicit path; B's workspace never appears for a member of A.
  it.each([
    [
      "an organization admin with a stored viewer row gets admin",
      UM,
      [row(WA1, OA, "admin"), row(WA2, OA, "admin")],
    ],
    [
      "an organization admin without a stored row reaches every workspace of the organization",
      UD,
      [row(WA1, OA, "admin"), row(WA2, OA, "admin")],
    ],
    [
      "a suspended stored row does not stop the implicit organization path",
      UN,
      [row(WA1, OA, "admin"), row(WA2, OA, "admin")],
    ],
    ["a suspended member with only a member organization row has no access", US, []],
    ["a stored owner who is also the organization owner keeps owner", UB, [row(WB, OB, "owner")]],
    ["an organization with no workspace gives nothing", UO, []],
    ["a user with no membership gives nothing", UX, []],
  ] as const)("%s", async (_title, user, expected) => {
    const found = await resolve(user);
    expect(found.sort(byId("workspace_id"))).toEqual([...expected].sort(byId("workspace_id")));
  });

  it("a workspace list or write workspace in the context changes nothing", async () => {
    const forged = { workspaceIds: [WB], writeWorkspaceId: WB, organizationId: OB };
    expect((await resolve(U1, forged)).map((r) => r.workspace_id).sort()).toEqual([WA1, WA2].sort());
  });
});

describe("my_workspaces and my_organizations (R198)", () => {
  const t = useDatabase(seedAccess);
  const page = (user: string, sql: string, after: string | null) => run(t, asUser(user), sql, [after]);
  const WORKSPACES = "SELECT * FROM app.my_workspaces(1, $1::uuid)";

  it("my_workspaces gives the caller's rows with name, slug and role, and never B's", async () => {
    const all = await run(t, asUser(U1), "SELECT * FROM app.my_workspaces(100, NULL)");
    expect(all.sort(byId("workspace_id"))).toEqual(
      [
        { workspace_id: WA1, organization_id: OA, name: "ws-a1", slug: "ws-a1", role_key: "viewer" },
        { workspace_id: WA2, organization_id: OA, name: "ws-a2", slug: "ws-a2", role_key: "editor" },
      ].sort(byId("workspace_id")),
    );
  });

  it.each([
    ["a suspended member", US, []],
    ["a member of B only sees B's workspace", UB, ["ws-b"]],
    ["the organization role: an organization admin sees admin", UM, ["ws-a1", "ws-a2"]],
  ] as const)("my_workspaces for %s", async (_title, user, names) => {
    const found = await run(t, asUser(user), "SELECT * FROM app.my_workspaces(100, NULL)");
    expect(found.map((r) => r.name).sort()).toEqual([...names]);
    if (user === UM) expect(found.map((r) => r.role_key)).toEqual(["admin", "admin"]);
  });

  it("two pages of one row cover the workspaces once, and the third is empty", async () => {
    const first = await page(U1, WORKSPACES, null);
    const second = await page(U1, WORKSPACES, first[0]?.workspace_id as string);
    const third = await page(U1, WORKSPACES, second[0]?.workspace_id as string);
    expect([...first, ...second].map((r) => r.workspace_id).sort()).toEqual([WA1, WA2].sort());
    expect(first).toHaveLength(1);
    expect(third).toEqual([]);
  });
});

describe("my_organizations and the page bounds (R198, R195)", () => {
  const t = useDatabase(seedAccess);
  const page = (user: string, sql: string, after: string | null) => run(t, asUser(user), sql, [after]);
  const ORGANIZATIONS = "SELECT * FROM app.my_organizations(1, $1::uuid)";

  it("my_organizations finds an organization with no workspace, with its type and the caller's role", async () => {
    const found = await run(t, asUser(UO), "SELECT * FROM app.my_organizations(100, NULL)");
    expect(found).toEqual([
      { organization_id: OE, name: "org-e", slug: "org-e", type: "personal", org_role: "owner" },
    ]);
  });

  it("my_organizations pages by id, covers each organization once, and never lists B's", async () => {
    const first = await page(U1, ORGANIZATIONS, null);
    const second = await page(U1, ORGANIZATIONS, first[0]?.organization_id as string);
    const third = await page(U1, ORGANIZATIONS, second[0]?.organization_id as string);
    expect([...first, ...second].map((r) => r.organization_id).sort()).toEqual([OA, OE].sort());
    expect(third).toEqual([]);
  });

  // R195: input validation, not a floor row.
  it.each(
    [
      "SELECT * FROM app.my_workspaces($1::int, NULL)",
      "SELECT * FROM app.my_organizations($1::int, NULL)",
    ].flatMap((sql) => [0, 101, null].map((lim) => [sql, lim] as const)),
  )("%s with lim %s is refused with 22023", async (sql, lim) => {
    await expect(run(t, asUser(U1), sql, [lim])).rejects.toMatchObject({ code: "22023" });
  });

  it.each([0, 101, null])("member_directory with lim %s is refused with 22023", async (lim) => {
    await expect(
      run(t, asUser(U1), "SELECT * FROM app.member_directory($1::uuid, $2::int, NULL)", [WA1, lim]),
    ).rejects.toMatchObject({ code: "22023" });
  });
});

describe("member_directory (R198)", () => {
  const t = useDatabase(seedAccess);
  const list = (workspace: string, lim = 100, after: string | null = null, user = U1) =>
    run(t, asUser(user), "SELECT * FROM app.member_directory($1::uuid, $2::int, $3::uuid)", [
      workspace,
      lim,
      after,
    ]);

  it("returns exactly user_id, name and image of the active stored members, and no email", async () => {
    const found = await list(WA1);
    expect(found.map((r) => Object.keys(r))).toEqual(found.map(() => ["user_id", "name", "image"]));
    expect(found.sort(byId("user_id"))).toEqual(
      [
        { user_id: U1, name: "access-u1", image: "u1.png" },
        { user_id: UM, name: "access-um", image: "um.png" },
      ].sort(byId("user_id")),
    );
  });

  it("lists neither suspended members nor implicit organization admins without a stored row", async () => {
    const ids = (await list(WA1)).map((r) => r.user_id);
    expect(ids).not.toContain(US);
    expect(ids).not.toContain(UN);
    expect(ids).not.toContain(UD);
  });

  it("gives zero rows for a workspace outside the caller's set, the same as for one that does not exist", async () => {
    expect(await list(WB)).toEqual([]);
    expect(await list(randomUUID())).toEqual([]);
    expect(await list(WB, 100, null, UX)).toEqual([]);
  });

  it("pages by user_id without overlap", async () => {
    const first = await list(WA1, 1);
    const second = await list(WA1, 1, first[0]?.user_id as string);
    const third = await list(WA1, 1, second[0]?.user_id as string);
    expect([...first, ...second].map((r) => r.user_id).sort()).toEqual([U1, UM].sort());
    expect(third).toEqual([]);
  });
});

// ---- the 500 limit ------------------------------------------------------------------------------------------------

describe("resolve_workspace_access never truncates (R197)", () => {
  const U501 = randomUUID();
  const U500 = randomUUID();
  const O501 = randomUUID();
  const O500 = randomUUID();
  const UBIG = randomUUID();
  // One statement per user: n workspaces in an organization, a stored viewer row for the user and the one stored
  // Owner row (another user) in each.
  const SEED_WORKSPACES = `
    WITH w AS (INSERT INTO app.workspaces (organization_id, name, slug)
                SELECT $1::uuid, 'w-' || g.n, 'w-' || g.n FROM generate_series(1, $2::int) AS g (n) RETURNING id)
    INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
      SELECT w.id, m.u::uuid, r.id FROM w CROSS JOIN (VALUES ($3, 'viewer'), ($4, 'owner')) AS m (u, k)
        JOIN app.roles r ON r.key = m.k AND r.workspace_id IS NULL`;
  const t = useDatabase(async (admin) => {
    await admin.query(
      `${addUser(U501, "big-501")}; ${addUser(U500, "big-500")}; ${addUser(UBIG, "big-owner")}`,
    );
    await admin.query(
      `INSERT INTO app.organizations (id, name, slug, type) VALUES
         ('${O501}', 'big-501', 'big-501', 'team'), ('${O500}', 'big-500', 'big-500', 'team')`,
    );
    await admin.query(SEED_WORKSPACES, [O501, 501, U501, UBIG]);
    await admin.query(SEED_WORKSPACES, [O500, 500, U500, UBIG]);
  });

  it("returns all 500 reachable workspaces", async () => {
    const found = await run(t, asUser(U500), "SELECT workspace_id FROM app.resolve_workspace_access()");
    expect(found).toHaveLength(500);
  });

  it.each(["SELECT * FROM app.resolve_workspace_access()", "SELECT * FROM app.my_workspaces(100, NULL)"])(
    "the 501st reachable workspace makes %s raise 54000",
    async (sql) => {
      await expect(run(t, asUser(U501), sql)).rejects.toMatchObject({ code: "54000" });
    },
  );
});

// ---- organization_create ------------------------------------------------------------------------------------------

/** n organizations of which the user is the owner, in one statement. */
const seedOwned = (user: string, tag: string, n: number) => (admin: Client) =>
  admin
    .query(
      `WITH o AS (INSERT INTO app.organizations (name, slug, type)
                   SELECT 'own-' || g.n, $3::text || '-' || g.n, 'team' FROM generate_series(1, $1::int) AS g (n) RETURNING id)
       INSERT INTO app.organization_members (organization_id, user_id, org_role) SELECT id, $2::uuid, 'owner' FROM o`,
      [n, user, tag],
    )
    .then(() => undefined);

const CREATE_ORGANIZATION = `SELECT app.organization_create('new-org', 'team', 'req-1', NULL, ${FRESH_KEY}) AS id`;
const CREATE_WORKSPACE = `SELECT app.workspace_create($1::uuid, 'new-ws', $2::text, 'Europe/Paris', 'req-2', NULL, ${FRESH_KEY}) AS id`;

describe("organization_create (R192, R194, R195, R176)", () => {
  const UC = randomUUID();
  const t = useDatabase((admin) => admin.query(addUser(UC, "create-uc")).then(() => undefined));

  it("one commit gives the organization, exactly one owner member (the caller) and one audit row on the instance chain", async () => {
    const created = (await run(t, asUser(UC), CREATE_ORGANIZATION))[0]?.id as string;
    expect(
      await t.rows("SELECT id, name, type, slug FROM app.organizations WHERE id = $1", [created]),
    ).toEqual([{ id: created, name: "new-org", type: "team", slug: `o-${created.replaceAll("-", "")}` }]);
    expect(
      await t.rows("SELECT user_id, org_role FROM app.organization_members WHERE organization_id = $1", [
        created,
      ]),
    ).toEqual([{ user_id: UC, org_role: "owner" }]);
    expect(
      await t.rows(
        `SELECT workspace_id, organization_id, actor_kind, actor_ref, action, resource_kind, resource_id, request_id
         FROM app.audit_logs WHERE organization_id = $1`,
        [created],
      ),
    ).toEqual([
      {
        workspace_id: null,
        organization_id: created,
        actor_kind: "user",
        actor_ref: UC,
        action: "organization.created",
        resource_kind: "organization",
        resource_id: created,
        request_id: "req-1",
      },
    ]);
    expect(await t.rows(HASH_BAD)).toEqual([{ bad: 0 }]);
  });

  it("ROLLBACK removes the organization, its member and its audit row, which existed before it", async () => {
    const seen =
      "SELECT count(*)::int AS n FROM app.my_organizations(100, NULL) WHERE organization_id = $1::uuid";
    const result = await footprint(t, () => createThenRollBack(t, UC, [CREATE_ORGANIZATION, []], seen));
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
    expect(result.delta).toEqual(NOTHING);
  });
});

describe("organization_create bound of 20 owned organizations (R194)", () => {
  const U20 = randomUUID();
  const UADM = randomUUID();
  const UKEEP = randomUUID();
  const t = useDatabase(async (admin) => {
    await admin.query(
      [addUser(U20, "create-u20"), addUser(UADM, "create-uadm"), addUser(UKEEP, "create-ukeep")].join(";"),
    );
    await seedOwned(U20, "n20", 20)(admin);
    // 20 organizations where UADM is an admin; each keeps a separate owner so the owner guard holds.
    await seedOwned(UKEEP, "keep", 20)(admin);
    await admin.query(
      `INSERT INTO app.organization_members (organization_id, user_id, org_role)
       SELECT organization_id, $1::uuid, 'admin' FROM app.organization_members WHERE user_id = $2::uuid`,
      [UADM, UKEEP],
    );
  });
  const owners = (user: string) =>
    t.rows(
      "SELECT count(*)::int AS n FROM app.organization_members WHERE user_id = $1 AND org_role = 'owner'",
      [user],
    );

  it("the 21st owned organization is refused with 53400 and leaves nothing behind", async () => {
    expect(await owners(U20)).toEqual([{ n: 20 }]);
    const result = await footprint(t, () => run(t, asUser(U20), CREATE_ORGANIZATION));
    expect(result.error).toMatchObject({ code: "53400" });
    expect(result.delta).toEqual(NOTHING);
    expect(await owners(U20)).toEqual([{ n: 20 }]);
  });

  // Only organizations the caller owns count: 20 admin rows and no owner row leave room for one.
  it("organizations where the caller is only an admin do not count toward the bound", async () => {
    const result = await footprint(t, () => run(t, asUser(UADM), CREATE_ORGANIZATION));
    expect(result.error).toBeUndefined();
    expect(result.delta).toMatchObject({ organizations: 1, organization_members: 1, audit_logs: 1 });
  });
});

describe("organization_create race at 19 owned organizations (R194)", () => {
  const U19 = randomUUID();
  const t = useDatabase(async (admin) => {
    await admin.query(addUser(U19, "create-u19"));
    await seedOwned(U19, "n19", 19)(admin);
  });

  // Forced, not hoped for: tx1 holds the instance head after its call, tx2 is seen waiting on it, then tx1 commits.
  it("two concurrent calls at 19 give exactly one success", async () => {
    const first = await openTx(t.app(), asUser(U19));
    const second = await openTx(t.app(), asUser(U19));
    const result = await footprint(t, () =>
      holdThenRace(t.rows, first, second, (client) => client.query(CREATE_ORGANIZATION)),
    );
    expect(result.error).toBeUndefined();
    expect((result.value as { secondError: unknown }).secondError).toMatchObject({ code: "53400" });
    expect(result.delta).toMatchObject({ organizations: 1, organization_members: 1, audit_logs: 1 });
  });
});

// ---- workspace_create ---------------------------------------------------------------------------------------------

const OW = randomUUID();
const OZ = randomUUID();
const WZ = randomUUID();
const UW1 = randomUUID();
const UW2 = randomUUID();
const UW3 = randomUUID();
const UW4 = randomUUID();
const UWX = randomUUID();

/** OW: UW1 owner, UW2 admin, UW3 member, UW4 billing. OZ: UWX owner, with the workspace WZ. */
async function seedWorkspaceCreate(admin: Client): Promise<void> {
  await admin.query([UW1, UW2, UW3, UW4, UWX].map((id, n) => addUser(id, `create-w${n}`)).join(";"));
  await admin.query(
    `INSERT INTO app.organizations (id, name, slug, type) VALUES
       ('${OW}', 'org-w', 'org-w', 'agency'), ('${OZ}', 'org-z', 'org-z', 'team');
     INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES
       ('${OW}', '${UW1}', 'owner'), ('${OW}', '${UW2}', 'admin'), ('${OW}', '${UW3}', 'member'),
       ('${OW}', '${UW4}', 'billing'), ('${OZ}', '${UWX}', 'owner');
     INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ('${WZ}', '${OZ}', 'ws-z', 'ws-z')`,
  );
}

/** One workspace_create call as `user`; `ctx` adds settings to the context. */
const createWorkspace =
  (t: Fixture) =>
  (user: string, organization: string, slug: string, ctx: Partial<TenantCtx> = {}) =>
    run(t, { ...asUser(user), ...ctx }, CREATE_WORKSPACE, [organization, slug]);

describe("workspace_create (R192, R193)", () => {
  const t = useDatabase(seedWorkspaceCreate);
  const create = createWorkspace(t);

  // The creator is the workspace's one stored Owner, the row is on the chain of its own workspace and day, in one transaction.
  it.each([
    ["an organization owner", UW1, "by-owner"],
    ["an organization admin", UW2, "by-admin"],
  ])(
    "%s creates the workspace, becomes its stored owner and one audit row is chained",
    async (_title, user, slug) => {
      const id = (await create(user, OW, slug))[0]?.id as string;
      expect(
        await t.rows("SELECT organization_id, name, slug, default_tz FROM app.workspaces WHERE id = $1", [
          id,
        ]),
      ).toEqual([{ organization_id: OW, name: "new-ws", slug, default_tz: "Europe/Paris" }]);
      expect(
        await t.rows(
          `SELECT m.user_id, m.status, r.key FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id
         WHERE m.workspace_id = $1`,
          [id],
        ),
      ).toEqual([{ user_id: user, status: "active", key: "owner" }]);
      expect(
        await t.rows(
          `SELECT workspace_id, organization_id, actor_kind, actor_ref, action, resource_kind, resource_id
         FROM app.audit_logs WHERE workspace_id = $1`,
          [id],
        ),
      ).toEqual([
        {
          workspace_id: id,
          organization_id: OW,
          actor_kind: "user",
          actor_ref: user,
          action: "workspace.created",
          resource_kind: "workspace",
          resource_id: id,
        },
      ]);
      expect(
        await t.rows("SELECT count(*)::int AS n FROM app.audit_heads WHERE workspace_id = $1", [id]),
      ).toEqual([{ n: 1 }]);
      expect(await t.rows(HASH_BAD)).toEqual([{ bad: 0 }]);
    },
  );
});

describe("workspace_create refusals (R193)", () => {
  const t = useDatabase(seedWorkspaceCreate);
  const create = createWorkspace(t);

  it("ROLLBACK removes the workspace, its owner row and its audit row, which existed before it", async () => {
    const seen =
      "SELECT count(*)::int AS n FROM app.resolve_workspace_access() WHERE workspace_id = $1::uuid";
    const result = await footprint(t, () =>
      createThenRollBack(t, UW1, [CREATE_WORKSPACE, [OW, "rolled-back"]], seen),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
    expect(result.delta).toEqual(NOTHING);
  });

  it.each([
    ["an organization member", UW3, () => OW],
    ["a billing member", UW4, () => OW],
    ["a user of another organization", UW1, () => OZ],
    ["an organization that does not exist", UW1, () => randomUUID()],
  ])("%s is refused with 42501 and nothing is left behind", async (_title, user, organization) => {
    const result = await footprint(t, () => create(user, organization(), "refused"));
    expect(result.error).toMatchObject({ code: "42501" });
    expect(result.delta).toEqual(NOTHING);
  });

  it("a foreign and a missing organization give the identical error and message", async () => {
    const failure = (organization: string) =>
      create(UW1, organization, "same").catch((error: Error) => error);
    const foreign = (await failure(OZ)) as Error & { code?: string };
    const missing = (await failure(randomUUID())) as Error & { code?: string };
    expect([foreign.code, missing.code]).toEqual(["42501", "42501"]);
    expect(foreign.message).toBe(missing.message);
  });

  it("an unknown time zone is refused with 22023 and nothing is left behind", async () => {
    const act = () =>
      run(t, asUser(UW1), CREATE_WORKSPACE.replace("'Europe/Paris'", "'Mars/Phobos'"), [OW, "bad-tz"]);
    const result = await footprint(t, act);
    expect(result.error).toMatchObject({ code: "22023" });
    expect(result.delta).toEqual(NOTHING);
  });

  it("a slug taken in the same organization is refused with 23505 and nothing is left behind", async () => {
    await create(UW1, OW, "taken");
    const result = await footprint(t, () => create(UW2, OW, "taken"));
    expect(result.error).toMatchObject({ code: "23505" });
    expect(result.delta).toEqual(NOTHING);
  });
});

describe("workspace_create ignores the workspace settings of the context (R193)", () => {
  const t = useDatabase(seedWorkspaceCreate);
  const create = createWorkspace(t);

  it("a forged workspace list or write workspace in the context changes nothing", async () => {
    const forged = { workspaceIds: [WZ], writeWorkspaceId: WZ, organizationId: OZ };
    await expect(create(UW3, OZ, "forged", forged)).rejects.toMatchObject({ code: "42501" });
    const id = (await create(UW1, OW, "forged-ok", forged))[0]?.id as string;
    expect(await t.rows("SELECT organization_id FROM app.workspaces WHERE id = $1", [id])).toEqual([
      { organization_id: OW },
    ]);
    expect(
      await t.rows("SELECT count(*)::int AS n FROM app.workspace_members WHERE workspace_id = $1", [WZ]),
    ).toEqual([{ n: 0 }]);
    expect(
      await t.rows("SELECT count(*)::int AS n FROM app.audit_logs WHERE workspace_id = $1", [WZ]),
    ).toEqual([{ n: 0 }]);
  });
});
