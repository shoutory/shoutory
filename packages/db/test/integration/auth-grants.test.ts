import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor: the identity tables belong to the auth role alone. They sit on the row-security allowlist, so the
// grants are the whole defence. One matrix constant per role: a later column grant adds a row here, it does not
// loosen the rest.
const TABLES = ["user", "session", "account", "verification", "two_factor"] as const;
const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const MATRIX: Record<string, string[]> = {
  shoutory_auth: DML,
  shoutory_app: [],
  shoutory_worker: [],
  shoutory_readonly: [],
  shoutory_definer: [],
  shoutory_owner: [...PRIVILEGES],
};

// The retention purge (purge_expired) is the one thing that deletes from three identity tables, and only as the definer.
const DEFINER_DELETES = ["user", "session", "verification"];

// `user` is a reserved word: it is the one name that must be quoted.
const qualified = (table: string): string => (table === "user" ? 'auth."user"' : `auth.${table}`);

async function privilegeViolations(pool: Pool): Promise<string[]> {
  const found: string[] = [];
  for (const [role, base] of Object.entries(MATRIX)) {
    for (const table of TABLES) {
      const allowed = role === "shoutory_definer" && DEFINER_DELETES.includes(table) ? ["DELETE"] : base;
      for (const privilege of PRIVILEGES) {
        const has = await pool.query("SELECT has_table_privilege($1, $2, $3) AS has", [
          role,
          qualified(table),
          privilege,
        ]);
        if (has.rows[0].has !== allowed.includes(privilege)) found.push(`${role} ${privilege} on ${table}`);
      }
    }
  }
  return found;
}

async function ownershipViolations(pool: Pool): Promise<string[]> {
  const owned = await pool.query(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relowner = 'shoutory_auth'::regrole AND c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')`,
  );
  const found = owned.rows.map((row) => `shoutory_auth owns ${row.name}`);
  const tables = await pool.query(
    `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
     WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'r' ORDER BY c.relname`,
  );
  const expected = [...TABLES].sort().map((relname) => ({ relname, owner: "shoutory_owner" }));
  if (JSON.stringify(tables.rows) !== JSON.stringify(expected)) {
    found.push("auth tables are not the five owned by the owner");
  }
  return found;
}

/** Everything the catalog says that the grant design forbids. An empty list is a pass. */
async function violations(pool: Pool): Promise<string[]> {
  return [...(await privilegeViolations(pool)), ...(await ownershipViolations(pool))];
}

/** One clone per describe. */
function useClone(): () => TestDatabase {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());
  return () => db;
}

describe("auth tables: grants", () => {
  const clone = useClone();

  it("shoutory_auth holds DML only and owns no relation; nobody else holds any privilege", async () => {
    expect(await violations(clone().pool("owner"))).toEqual([]);
  });
});

describe("auth tables: shape under shoutory_auth", () => {
  const clone = useClone();

  it("a BA-shaped sign-up works and a user delete cascades", async () => {
    const auth = clone().pool("auth");
    const user = await auth.query(
      `INSERT INTO auth."user" (name, email) VALUES ('grants-user-1', 'grants-user-1@example.test') RETURNING id, email_verified`,
    );
    const id = user.rows[0].id as string;
    expect(user.rows[0].email_verified).toBe(false);
    await auth.query(
      `INSERT INTO auth.account (account_id, provider_id, user_id, password) VALUES ($1::text, 'credential', $1::uuid, 'grants-hash-1')`,
      [id],
    );
    await auth.query(
      `INSERT INTO auth.session (token, expires_at, user_id, ip_hmac) VALUES ('grants-token-1', now() + interval '7 days', $1, 'grants-ip-1')`,
      [id],
    );
    await auth.query(
      `INSERT INTO auth.verification (identifier, value, expires_at) VALUES ('grants-user-1', 'v', now())`,
    );
    await auth.query(`INSERT INTO auth.two_factor (secret, backup_codes, user_id) VALUES ('s', 'b', $1)`, [
      id,
    ]);
    await auth.query(`DELETE FROM auth."user" WHERE id = $1`, [id]);
    for (const table of ["account", "session", "two_factor"]) {
      const left = await auth.query(`SELECT count(*)::int AS n FROM auth.${table}`);
      expect(left.rows[0].n).toBe(0);
    }
  });

  it.each([
    ["an upper-case email", "Grants-Upper@example.test", "23514"],
    ["a duplicate email", "grants-dup@example.test", "23505"],
  ])("auth.user refuses %s", async (_title, email, code) => {
    const auth = clone().pool("auth");
    await auth.query(
      `INSERT INTO auth."user" (name, email) VALUES ('grants-dup', 'grants-dup@example.test') ON CONFLICT DO NOTHING`,
    );
    const insert = auth.query(`INSERT INTO auth."user" (name, email) VALUES ('grants-other', $1)`, [email]);
    await expect(insert).rejects.toMatchObject({ code });
  });
});

// The check must fail for a grant planted on purpose: one row per way the matrix can be broken.
describe("the auth grant check catches a planted grant", () => {
  const clone = useClone();

  it.each([
    ["GRANT SELECT ON auth.session TO shoutory_app", "shoutory_app SELECT on session"],
    ["GRANT SELECT ON auth.account TO shoutory_readonly", "shoutory_readonly SELECT on account"],
    ["GRANT DELETE ON auth.account TO shoutory_definer", "shoutory_definer DELETE on account"],
    ["GRANT UPDATE ON auth.verification TO shoutory_definer", "shoutory_definer UPDATE on verification"],
    ["GRANT TRUNCATE ON auth.two_factor TO shoutory_auth", "shoutory_auth TRUNCATE on two_factor"],
    ["ALTER TABLE auth.session OWNER TO shoutory_auth", "shoutory_auth owns auth.session"],
  ])("%s", async (statement, expected) => {
    await withAdminClient(env, clone().name, async (admin) => {
      await admin.query(statement);
      try {
        expect(await violations(clone().pool("owner"))).toContain(expected);
      } finally {
        const undo = statement.startsWith("ALTER")
          ? "ALTER TABLE auth.session OWNER TO shoutory_owner"
          : statement.replace("GRANT", "REVOKE").replace(" TO ", " FROM ");
        await admin.query(undo);
      }
    });
  });
});
