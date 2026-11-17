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

// R91: a definer sets its purpose at entry and puts the caller's value back at exit, so a job's own purpose does
// not change under it.
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
