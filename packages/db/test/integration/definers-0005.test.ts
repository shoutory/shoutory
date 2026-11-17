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

// Security floor: one row per definer of migration 0005. A definer is owned by the NOLOGIN definer role, pins its
// search path, is executable by exactly its callers (never PUBLIC), and reads or writes only the table its purpose
// policy names. The constant is the definer matrix of the M0 plan; later migrations add rows.
interface Definer {
  name: string;
  args: string;
  callers: string[];
  /** An internal helper: not SECURITY DEFINER, callable by no one but the definers that share its owner. */
  helper?: true;
}
const DEFINERS: Definer[] = [
  {
    name: "bucket_take",
    args: "key text, scope text, cost integer",
    callers: ["shoutory_auth", "shoutory_app", "shoutory_worker"],
  },
  {
    name: "bucket_state",
    args: "key text, scope text",
    callers: ["shoutory_auth", "shoutory_app", "shoutory_worker"],
  },
  {
    name: "step_up_record",
    args: "session_id uuid, user_id uuid, method text",
    callers: ["shoutory_auth"],
  },
  {
    name: "step_up_read",
    args: "session_id uuid, user_id uuid",
    callers: ["shoutory_auth", "shoutory_app"],
  },
  {
    name: "password_recheck_set",
    args: "user_id uuid, due timestamp with time zone",
    callers: ["shoutory_auth"],
  },
  { name: "instance_admin_claim", args: "user_id uuid", callers: ["shoutory_auth"] },
  { name: "bucket_limits", args: "scope text", callers: [], helper: true },
];

// The table each purpose policy opens for reading, with the purpose that opens it.
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

/** One clone per describe, seeded with one row in each table a definer touches when `seeded`. */
function useClone(seeded: boolean): () => TestDatabase {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    if (seeded) await withAdminClient(env, db.name, seed);
  });
  afterAll(() => db.drop());
  return () => db;
}

describe("definers of migration 0005: catalog", () => {
  const clone = useClone(false);
  const db = { pool: (role: "owner" | "readonly") => clone().pool(role) };

  const catalog = (name: string) =>
    db.pool("owner").query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
              pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1`,
      [name],
    );

  it.each(DEFINERS)(
    "$name is owned by the definer, with a pinned path and the stated security",
    async (d) => {
      const found = await catalog(d.name);
      expect(found.rows).toEqual([
        {
          owner: "shoutory_definer",
          prosecdef: d.helper !== true,
          proconfig: [`search_path=${d.helper ? "pg_catalog, pg_temp" : "pg_catalog, app, pg_temp"}`],
          args: d.args,
        },
      ]);
    },
  );

  it("session_step_ups has an index led by user_id, the key of the template U predicate and the cascade", async () => {
    const found = await db.pool("owner").query(
      `SELECT count(*)::int AS n FROM pg_index i
       WHERE i.indrelid = 'app.session_step_ups'::regclass AND i.indkey[0] = (
         SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'user_id')`,
    );
    expect(found.rows[0].n).toBe(1);
  });

  it.each(DEFINERS)("$name is executable by exactly its callers and never by PUBLIC", async (d) => {
    const found = await db.pool("owner").query(
      `SELECT coalesce(r.rolname, 'PUBLIC') AS grantee
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1 AND a.privilege_type = 'EXECUTE'`,
      [d.name],
    );
    expect(found.rows.map((row) => row.grantee).sort()).toEqual([...d.callers, "shoutory_definer"].sort());
  });

  it("a role outside the matrix is refused when it calls a definer", async () => {
    const call = db
      .pool("readonly")
      .query("SELECT * FROM app.bucket_state($1, 'login_ip')", ["b".repeat(64)]);
    await expect(call).rejects.toMatchObject({ code: "42501" });
  });
});

// The definer runs the statement, so the purpose policy decides what it sees: the right purpose sees the seeded
// row, any other purpose and no purpose see nothing.
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
