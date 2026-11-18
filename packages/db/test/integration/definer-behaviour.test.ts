import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

interface Fixture {
  db: () => TestDatabase;
  auth: () => Pool;
  user: string;
}

/** One clone with one user, made through the auth role as sign-up does. */
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

type Principal = { id?: string; kind?: string };

/** One instance_setting_set call in its own transaction, with the settings of a session; returns the purpose after. */
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
    await client.query("SELECT app.instance_setting_set($1, $2::jsonb)", [key, JSON.stringify(value)]);
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
