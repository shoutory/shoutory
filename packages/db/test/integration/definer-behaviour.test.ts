import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, digestOf, plantInvitation, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

interface Fixture {
  db: () => TestDatabase;
  auth: () => Pool;
  user: string;
}

function useUser(): Fixture {
  let db: TestDatabase;
  let auth: Pool;
  const user = randomUUID();
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    auth = db.pool("auth");
    await auth.query(
      `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'behaviour-1', 'behaviour-1@example.test')`,
      [user],
    );
  });
  afterAll(() => db.drop());
  return { db: () => db, auth: () => auth, user };
}

describe("password_recheck_set", () => {
  const t = useUser();
  const recheckAt = () =>
    withAdminClient(
      env,
      t.db().name,
      async (admin) =>
        (
          await admin.query("SELECT password_recheck_at AS at FROM app.user_profiles WHERE user_id = $1", [
            t.user,
          ])
        ).rows,
    );

  it("creates the profile with the due time, moves it, and NULL clears it", async () => {
    const first = new Date("2030-01-01T00:00:00Z");
    const second = new Date("2030-02-01T00:00:00Z");
    await t.auth().query("SELECT app.password_recheck_set($1, $2)", [t.user, first]);
    expect(await recheckAt()).toEqual([{ at: first }]);
    await t.auth().query("SELECT app.password_recheck_set($1, $2)", [t.user, second]);
    expect(await recheckAt()).toEqual([{ at: second }]);
    await t.auth().query("SELECT app.password_recheck_set($1, NULL)", [t.user]);
    expect(await recheckAt()).toEqual([{ at: null }]);
  });
});

describe("user_avatar_set (floor)", () => {
  const t = useUser();
  const other = randomUUID();
  const OTHER_AT = new Date("2030-03-01T00:00:00Z");
  beforeAll(() =>
    withAdminClient(env, t.db().name, async (admin) => {
      await admin.query(
        `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'behaviour-2', 'behaviour-2@example.test')`,
        [other],
      );
      await admin.query("INSERT INTO app.user_profiles (user_id, avatar_at) VALUES ($1, $2)", [
        other,
        OTHER_AT,
      ]);
    }),
  );
  const avatars = () =>
    withAdminClient(
      env,
      t.db().name,
      async (admin) =>
        (await admin.query("SELECT user_id, avatar_at AS at FROM app.user_profiles ORDER BY avatar_at")).rows,
    );
  const call = async (ctx: Parameters<typeof openTx>[1], at: Date | null, prior?: string) => {
    const client = await openTx(t.db().pool("app"), ctx);
    try {
      if (prior) await client.query("SELECT set_config('app.job_purpose', $1, true)", [prior]);
      await client.query("SELECT app.user_avatar_set($1)", [at]);
      const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
      await client.query("COMMIT");
      return after.rows[0].purpose || undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("sets and clears only the caller's own row and puts the caller's purpose back", async () => {
    const at = new Date("2030-01-01T00:00:00Z");
    expect(await call(asUser(t.user), at, "x")).toBe("x");
    expect(await avatars()).toEqual([
      { user_id: t.user, at },
      { user_id: other, at: OTHER_AT },
    ]);
    expect(await call(asUser(t.user), null)).toBeUndefined();
    expect(await avatars()).toEqual([
      { user_id: other, at: OTHER_AT },
      { user_id: t.user, at: null },
    ]);
  });

  it.each([
    ["no principal", null],
    ["a job", { principalKind: "job", jobPurpose: "user_avatar_set" }],
    ["a service", { principalKind: "service", principalId: randomUUID(), serviceKind: "api_key" }],
  ] as const)("refuses a call by %s", async (_who, ctx) => {
    await expect(call(ctx as Parameters<typeof openTx>[1], new Date())).rejects.toMatchObject({
      code: "42501",
    });
  });
});

// A definer sets its purpose at entry and puts the caller's value back at exit, so a job's own purpose does not
// change under it.
describe("every 0005 definer restores the caller's job purpose", () => {
  const t = useUser();
  const key = "c".repeat(64);
  const calls = (user: string): [string, string, unknown[]][] => [
    ["bucket_take", "SELECT * FROM app.bucket_take($1, 'login_ip', 1)", [key]],
    ["bucket_state", "SELECT * FROM app.bucket_state($1, 'login_ip')", [key]],
    ["step_up_record", "SELECT app.step_up_record($1, $2, 'password')", [randomUUID(), user]],
    ["step_up_read", "SELECT * FROM app.step_up_read($1, $2)", [randomUUID(), user]],
    ["password_recheck_set", "SELECT app.password_recheck_set($1, now())", [user]],
    ["instance_admin_claim", "SELECT app.instance_admin_claim($1)", [user]],
  ];

  it.each(
    calls(t.user).flatMap(([name, sql, args]) => [
      [name, "x", sql, args] as const,
      [name, undefined, sql, args] as const,
    ]),
  )("%s (prior %s)", async (_name, prior, sql, args) => {
    const client = await t.auth().connect();
    try {
      await client.query("BEGIN");
      if (prior) await client.query("SELECT set_config('app.job_purpose', $1, true)", [prior]);
      await client.query(sql, args as unknown[]);
      const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
      expect(after.rows[0].purpose || undefined).toBe(prior);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

async function seedOwnerOfWorkspace(
  admin: Client,
  user: string,
  organization: string,
  workspace: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'behaviour-3', 'behaviour-3@example.test')`,
    [user],
  );
  await admin.query(
    `INSERT INTO app.organizations (id, name, slug, type) VALUES ('${organization}', 'behaviour-org', 'behaviour-org', 'team');
     INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ('${organization}', '${user}', 'owner');
     INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ('${workspace}', '${organization}', 'behaviour-ws', 'behaviour-ws');
     INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       SELECT '${workspace}', '${user}', id FROM app.roles WHERE key = 'owner' AND workspace_id IS NULL`,
  );
}

// A creation call spends a tenant_create token; a fresh key per call keeps these tests off each other's bucket.
const FRESH_KEY = "encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex')";

const accessCalls = (organization: string, workspace: string): [string, string, unknown[]][] => [
  ["resolve_workspace_access", "SELECT * FROM app.resolve_workspace_access()", []],
  ["my_workspaces", "SELECT * FROM app.my_workspaces(10, NULL)", []],
  ["my_organizations", "SELECT * FROM app.my_organizations(10, NULL)", []],
  ["member_directory", "SELECT * FROM app.member_directory($1::uuid, 10, NULL)", [workspace]],
  [
    "workspace_create",
    `SELECT id FROM app.workspace_create($1::uuid, 'n', $2::text, 'UTC', NULL, NULL, ${FRESH_KEY}, NULL, NULL, true)`,
    [organization, "b-slug"],
  ],
  [
    "organization_create",
    `SELECT id FROM app.organization_create('n', 'team', NULL, NULL, ${FRESH_KEY}, NULL)`,
    [],
  ],
];

// member_directory and my_workspaces call resolve_workspace_access inside, so their rows also prove that a nested
// call puts the outer purpose back.
describe("every 0009 definer restores the caller's job purpose", () => {
  const user = randomUUID();
  const organization = randomUUID();
  const workspace = randomUUID();
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await withAdminClient(env, db.name, (admin) =>
      seedOwnerOfWorkspace(admin, user, organization, workspace),
    );
  });
  afterAll(() => db.drop());

  it.each(
    accessCalls(organization, workspace).flatMap(([name, sql, args]) => [
      [name, "x", sql, args] as const,
      [name, undefined, sql, args] as const,
    ]),
  )("%s (prior %s)", async (_name, prior, sql, args) => {
    const client = await openTx(db.pool("app"), { principalKind: "user", principalId: user });
    try {
      if (prior) await client.query("SELECT set_config('app.job_purpose', $1, true)", [prior]);
      await client.query(sql, args as unknown[]);
      const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
      expect(after.rows[0].purpose || undefined).toBe(prior);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("every 0010 definer restores the caller's job purpose", () => {
  let db: TestDatabase;
  let revokeId = "";
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    revokeId = await withAdminClient(env, db.name, async (admin) => {
      await seedMembers(admin);
      await plantInvitation(admin, { token: "behaviour-accept" });
      await plantInvitation(admin, { token: "behaviour-revoke", email: "behaviour-revoke@example.test" });
      const found = await admin.query("SELECT id FROM app.invitations WHERE token_hash = $1", [
        digestOf("behaviour-revoke"),
      ]);
      return String(found.rows[0].id);
    });
  });
  afterAll(() => db.drop());

  const NEW =
    "SELECT app.invitation_create($1::uuid, 'behaviour-new@example.test', 'viewer', '1 day', $2, NULL, NULL)";
  const REVOKE = "SELECT app.invitation_revoke($1::uuid, $2::uuid, NULL, NULL)";
  const SET_ROLE = "SELECT app.member_role_set($1::uuid, $2::uuid, 'viewer', NULL, NULL)";
  const REMOVE = "SELECT app.member_remove($1::uuid, $2::uuid, NULL, NULL)";
  const calls: [string, string, string, () => unknown[]][] = [
    ["invitation_create", U.admin, NEW, () => [WA, digestOf("behaviour-create")]],
    ["invitation_revoke", U.admin, REVOKE, () => [WA, revokeId]],
    ["member_role_set", U.admin, SET_ROLE, () => [WA, U.editor]],
    ["member_remove", U.admin, REMOVE, () => [WA, U.editor]],
    [
      "invitation_accept",
      U.invitee,
      "SELECT app.invitation_accept($1, NULL, NULL)",
      () => [digestOf("behaviour-accept")],
    ],
  ];

  it.each(calls.flatMap((call) => [[...call, "x"] as const, [...call, undefined] as const]))(
    "%s (prior %s)",
    async (_name, caller, sql, args, prior) => {
      const ctx = { ...asUser(caller), ...(prior ? { jobPurpose: prior } : {}) };
      const result = await attempt(db.pool("app"), ctx, sql, args(), [
        "SELECT current_setting('app.job_purpose', true) AS purpose",
      ]);
      expect(result.error).toBeUndefined();
      expect(result.after?.[0]?.purpose || undefined).toBe(prior);
    },
  );
});

type Principal = { id?: string; kind?: string };

async function setInstanceSetting(
  t: Fixture,
  who: Principal,
  key: string,
  value: unknown,
  extra: Record<string, string> = {},
): Promise<string> {
  const settings = { "app.principal_id": who.id ?? "", "app.principal_kind": who.kind ?? "", ...extra };
  const client = await t.db().pool("app").connect();
  try {
    await client.query("BEGIN");
    for (const [name, setting] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [name, setting]);
    }
    await client.query("SELECT app.instance_setting_set($1, $2::jsonb, 'req-setting-1', NULL)", [
      key,
      JSON.stringify(value),
    ]);
    const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
    await client.query("COMMIT");
    return after.rows[0].purpose as string;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const storedSettings = (t: Fixture) =>
  withAdminClient(
    env,
    t.db().name,
    async (admin) => (await admin.query("SELECT key, value, updated_by FROM app.instance_settings")).rows,
  );

describe("instance_setting_set", () => {
  const t = useUser();
  const outsider = randomUUID();
  const call = (who: Principal, key: string, value: unknown, extra?: Record<string, string>) =>
    setInstanceSetting(t, who, key, value, extra);
  const stored = () => storedSettings(t);

  beforeAll(async () => {
    await withAdminClient(env, t.db().name, async (admin) => {
      await admin.query(
        `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'behaviour-2', 'behaviour-2@example.test')`,
        [outsider],
      );
      await admin.query("INSERT INTO app.instance_admins (user_id) VALUES ($1)", [t.user]);
    });
  });

  it("an admin sets the value and sets it again", async () => {
    const admin = { id: t.user, kind: "user" };
    await call(admin, "signup_enabled", true);
    expect(await stored()).toEqual([{ key: "signup_enabled", value: true, updated_by: t.user }]);
    await call(admin, "signup_enabled", false);
    expect(await stored()).toEqual([{ key: "signup_enabled", value: false, updated_by: t.user }]);
  });

  it.each([
    ["a user who is not an admin", { id: outsider, kind: "user" }, "signup_enabled", true, "42501"],
    [
      "an admin's id under a service principal",
      { id: t.user, kind: "service" },
      "signup_enabled",
      true,
      "42501",
    ],
    ["no principal at all", {}, "signup_enabled", true, "42501"],
    ["an unknown key", { id: t.user, kind: "user" }, "other_setting", true, "22023"],
  ] as [string, Principal, string, unknown, string][])(
    "%s is refused and changes nothing",
    async (_title, who, key, value, code) => {
      const before = await stored();
      await expect(call(who, key, value)).rejects.toMatchObject({ code });
      expect(await stored()).toEqual(before);
    },
  );

  it.each([["yes"], [1], [null]])("the value %j is not a boolean and is refused", async (value) => {
    const before = await stored();
    await expect(call({ id: t.user, kind: "user" }, "signup_enabled", value)).rejects.toMatchObject({
      code: "22023",
    });
    expect(await stored()).toEqual(before);
  });

  it("the caller's purpose is back after the call", async () => {
    const purpose = await call({ id: t.user, kind: "user" }, "signup_enabled", true, {
      "app.job_purpose": "x",
    });
    expect(purpose).toBe("x");
  });
});
