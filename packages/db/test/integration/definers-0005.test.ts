import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

const POLICIES = [
  ["rate_buckets", "bucket_take"],
  ["rate_buckets", "bucket_state"],
  ["session_step_ups", "step_up_read"],
  ["user_profiles", "password_recheck_set"],
  ["instance_admins", "instance_admin_claim"],
] as const;
const U1 = randomUUID();

async function seed(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO auth."user" (id, name, email) VALUES ($1, 'definer-1', 'definer-1@example.test')`,
    [U1],
  );
  await admin.query("INSERT INTO app.user_profiles (user_id) VALUES ($1)", [U1]);
  await admin.query(
    "INSERT INTO app.session_step_ups (session_id, user_id, method) VALUES ($1, $1, 'password')",
    [U1],
  );
  await admin.query("INSERT INTO app.instance_admins (user_id) VALUES ($1)", [U1]);
  await admin.query("INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('login_ip', $1, 1)", [
    "b".repeat(64),
  ]);
}

function useClone(seeded: boolean): () => TestDatabase {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    if (seeded) await withAdminClient(env, db.name, seed);
  });
  afterAll(() => db.drop());
  return () => db;
}

describe("definers of migration 0005: index and caller", () => {
  const clone = useClone(false);
  const db = { pool: (role: "owner" | "readonly") => clone().pool(role) };

  it("session_step_ups has an index led by user_id, the key of the own-rows predicate and the cascade", async () => {
    const found = await db.pool("owner").query(
      `SELECT count(*)::int AS n FROM pg_index i
       WHERE i.indrelid = 'app.session_step_ups'::regclass AND i.indkey[0] = (
         SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'user_id')`,
    );
    expect(found.rows[0].n).toBe(1);
  });

  it("a role outside the matrix is refused when it calls a definer", async () => {
    const call = db
      .pool("readonly")
      .query("SELECT * FROM app.bucket_state($1, 'login_ip')", ["b".repeat(64)]);
    await expect(call).rejects.toMatchObject({ code: "42501" });
  });
});

describe("definers of migration 0005: purpose policies", () => {
  const clone = useClone(true);
  const countAs = async (table: string, purpose: string | undefined) => {
    const client = await clone().pool("owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE shoutory_definer");
      if (purpose) await client.query("SELECT set_config('app.job_purpose', $1, true)", [purpose]);
      return (await client.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0].n as number;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  it.each(POLICIES)("the purpose policy of %s opens it for %s", async (table, purpose) => {
    expect(await countAs(table, purpose)).toBe(1);
  });

  // A purpose that belongs to another table opens nothing here: step_up_read is no key to rate_buckets.
  it.each(
    ["rate_buckets", "session_step_ups", "user_profiles", "instance_admins"].flatMap((table) => [
      [table, "unrelated_purpose"],
      [table, undefined],
      [table, table === "rate_buckets" ? "step_up_read" : "bucket_take"],
    ]) as [string, string | undefined][],
  )("the definer role sees 0 rows of %s under the purpose %s", async (table, purpose) => {
    expect(await countAs(table, purpose)).toBe(0);
  });
});
