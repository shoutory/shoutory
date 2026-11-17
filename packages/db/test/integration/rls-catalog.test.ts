import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor, read from the catalog: no function is callable by PUBLIC, every helper is a pinned, invoker,
// stable function granted to exactly the roles that run policies, and no default can widen any of it later.
const HELPERS = [
  "ws_ids",
  "write_ws",
  "org",
  "job_purpose",
  "principal_kind",
  "service_kind",
  "principal_id",
  "portal_grant_id",
] as const;
const PINNED = [...HELPERS, "apply_rls_template"] as const;
const POLICY_ROLES = ["shoutory_owner", "shoutory_app", "shoutory_worker", "shoutory_definer"];

// A NULL ACL means the default, which for a function is EXECUTE to PUBLIC plus the owner.
const GRANTEES = `
  SELECT p.proname, coalesce(r.rolname, 'PUBLIC') AS grantee
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = $1 AND a.privilege_type = 'EXECUTE'`;

// One clone per describe; the owner pool reads the catalog.
function useOwnerPool(): () => Pool {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());
  return () => db.pool("owner");
}

describe("row security catalog: PUBLIC", () => {
  const owner = useOwnerPool();

  it("no function in app or auth grants EXECUTE to PUBLIC", async () => {
    const count = await owner().query(
      "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'",
    );
    // The row is vacuous with no function in the schema: the helpers and the template function must exist.
    expect(count.rows[0].n).toBeGreaterThanOrEqual(PINNED.length);
    for (const schema of ["app", "auth"]) {
      const open = await owner().query(`${GRANTEES} AND r.rolname IS NULL`, [schema]);
      expect(open.rows).toEqual([]);
    }
  });

  it("a function the owner creates without any REVOKE has no PUBLIC EXECUTE", async () => {
    await owner().query("CREATE FUNCTION app.probe_default_acl() RETURNS int LANGUAGE sql AS 'SELECT 1'");
    try {
      const found = await owner().query(`${GRANTEES} AND p.proname = 'probe_default_acl'`, ["app"]);
      expect(found.rows.map((row) => row.grantee)).toEqual(["shoutory_owner"]);
    } finally {
      await owner().query("DROP FUNCTION app.probe_default_acl()");
    }
  });
});

describe("row security catalog: helpers", () => {
  const owner = useOwnerPool();

  it.each(PINNED)("%s pins search_path to pg_catalog, pg_temp and nothing else", async (name) => {
    const found = await owner().query(
      "SELECT proconfig FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = $1",
      [name],
    );
    expect(found.rows).toEqual([{ proconfig: ["search_path=pg_catalog, pg_temp"] }]);
  });

  it.each(HELPERS)("%s is STABLE and not SECURITY DEFINER", async (name) => {
    const found = await owner().query(
      "SELECT provolatile, prosecdef FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = $1",
      [name],
    );
    expect(found.rows).toEqual([{ provolatile: "s", prosecdef: false }]);
  });

  it.each(HELPERS)("%s is executable by exactly the owner, app, worker and definer roles", async (name) => {
    const found = await owner().query(`${GRANTEES} AND p.proname = $2`, ["app", name]);
    expect(found.rows.map((row) => row.grantee).sort()).toEqual([...POLICY_ROLES].sort());
  });

  it("apply_rls_template is executable by the owner alone", async () => {
    const found = await owner().query(`${GRANTEES} AND p.proname = 'apply_rls_template'`, ["app"]);
    expect(found.rows.map((row) => row.grantee)).toEqual(["shoutory_owner"]);
  });

  it.each(["shoutory_app", "shoutory_worker", "shoutory_auth", "shoutory_readonly"])(
    "%s cannot create objects in schema public",
    async (role) => {
      const found = await owner().query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS can", [role]);
      expect(found.rows[0].can).toBe(false);
    },
  );

  it("no role or database setting carries an app.* value", async () => {
    const found = await owner().query(
      `SELECT s.setconfig FROM pg_db_role_setting s, unnest(s.setconfig) AS entry
       WHERE entry LIKE 'app.%'
         AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))`,
    );
    expect(found.rows).toEqual([]);
  });
});
