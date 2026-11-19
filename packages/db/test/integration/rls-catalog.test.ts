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

  // The functions of schema app are checked one by one below (helpers, definers, the template function).
  it("no function in schema auth grants EXECUTE to PUBLIC", async () => {
    const open = await owner().query(`${GRANTEES} AND r.rolname IS NULL`, ["auth"]);
    expect(open.rows).toEqual([]);
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

// The definer matrix: every function of schema app owned by the definer role, with the roles that may call it. A
// later migration adds its definers here; a function not listed fails the first test by name.
interface Definer {
  name: string;
  /** The identity arguments, so an added overload of the same name is caught. */
  args: string;
  callers: string[];
  /** Not SECURITY DEFINER: an internal helper that only the definers call. */
  helper?: true;
}
const AUTH_APP_WORKER = ["shoutory_auth", "shoutory_app", "shoutory_worker"];
const SEALED_LINK =
  "link_ciphertext bytea, link_iv bytea, link_auth_tag bytea, link_wrap_iv bytea, link_wrap_tag bytea, link_wrapped_dek bytea, link_key_id text, link_format_version integer";
const DEFINERS: Definer[] = [
  { name: "bucket_take", args: "key text, scope text, cost integer", callers: AUTH_APP_WORKER },
  { name: "bucket_state", args: "key text, scope text", callers: AUTH_APP_WORKER },
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
  {
    name: "email_outbox_enqueue",
    args: `id uuid, workspace_id uuid, recipient text, template text, locale text, vars jsonb, ${SEALED_LINK}, link_digest text`,
    callers: ["shoutory_auth", "shoutory_app"],
  },
  { name: "sealed_key_ids", args: "", callers: ["shoutory_app", "shoutory_worker"] },
  {
    name: "email_outbox_reseal_batch",
    args: "lim integer, active_key_id text, after_id uuid",
    callers: ["shoutory_worker"],
  },
  {
    name: "email_outbox_reseal_write",
    args: `id uuid, expected_generation integer, ${SEALED_LINK}`,
    callers: ["shoutory_worker"],
  },
  {
    name: "instance_setting_set",
    args: "key text, value jsonb, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  { name: "flags_read", args: "", callers: ["shoutory_app", "shoutory_worker"] },
  { name: "instance_admin_check", args: "", callers: ["shoutory_app"] },
  {
    name: "feature_flag_override_set",
    args: "flag_key text, enabled boolean, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  { name: "organization_owner_guard", args: "", callers: [] },
  {
    name: "audit_insert",
    args: "action text, resource_kind text, resource_id text, request_id text, ip_hmac bytea, metadata jsonb",
    callers: ["shoutory_app", "shoutory_worker"],
  },
  {
    name: "audit_insert_instance",
    args: "action text, actor_kind text, actor_ref text, request_id text, ip_hmac bytea, metadata jsonb",
    callers: ["shoutory_auth"],
  },
  {
    name: "audit_append",
    args: "workspace_id uuid, organization_id uuid, actor_kind text, actor_ref text, action text, resource_kind text, resource_id text, request_id text, ip_hmac bytea, metadata jsonb",
    callers: [],
  },
  { name: "audit_immutable", args: "", callers: [], helper: true },
  { name: "resolve_workspace_access", args: "", callers: ["shoutory_app"] },
  { name: "my_workspaces", args: "lim integer, after uuid", callers: ["shoutory_app"] },
  { name: "my_organizations", args: "lim integer, after uuid", callers: ["shoutory_app"] },
  {
    name: "workspace_create",
    args: "organization_id uuid, name text, slug text, tz text, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "organization_create",
    args: "name text, type text, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  { name: "member_directory", args: "workspace_id uuid, lim integer, after uuid", callers: ["shoutory_app"] },
  { name: "role_weight", args: "key text", callers: [], helper: true },
  { name: "tenancy_rank", args: "ws uuid, who uuid", callers: [], helper: true },
  {
    name: "tenancy_enter",
    args: "fname text, ws uuid, caller uuid, need integer",
    callers: [],
    helper: true,
  },
  {
    name: "invitation_create",
    args: "workspace_id uuid, email text, role_key text, expires_in interval, token_digest bytea, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "invitation_revoke",
    args: "workspace_id uuid, invitation_id uuid, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  { name: "tenancy_lock", args: "ws uuid", callers: [], helper: true },
  { name: "workspace_owner_guard", args: "", callers: [] },
  {
    name: "invitation_accept",
    args: "token_digest bytea, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "member_role_set",
    args: "workspace_id uuid, user_id uuid, role_key text, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "member_remove",
    args: "workspace_id uuid, user_id uuid, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  // 0012
  { name: "signup_gate", args: "email text", callers: ["shoutory_auth"] },
  { name: "signup_open", args: "", callers: ["shoutory_auth", "shoutory_app"] },
  { name: "instance_settings_read", args: "", callers: ["shoutory_app"] },
  { name: "audit_chain_check", args: "day date", callers: ["shoutory_owner"] },
  { name: "worker_heartbeat", args: "worker_id text, role text", callers: ["shoutory_worker"] },
  {
    name: "email_suppression_add",
    args: "email_digest text, reason text",
    callers: ["shoutory_worker", "shoutory_app"],
  },
  { name: "email_outbox_claim", args: "lim integer", callers: ["shoutory_worker"] },
  { name: "email_outbox_mark", args: "id uuid, attempt integer, ok boolean", callers: ["shoutory_worker"] },
  { name: "outbox_claim", args: "lim integer", callers: ["shoutory_worker"] },
  {
    name: "outbox_mark",
    args: "id uuid, created_at text, attempt integer",
    callers: ["shoutory_worker"],
  },
  { name: "ensure_partitions", args: "", callers: ["shoutory_worker"] },
  { name: "purge_expired", args: "class text", callers: ["shoutory_worker"] },
  { name: "outbox_lag", args: "", callers: ["shoutory_app"] },
  { name: "worker_status", args: "", callers: ["shoutory_app"] },
  { name: "job_lag", args: "", callers: ["shoutory_app"] },
];
const TENANCY_TABLES = ["organizations", "organization_members", "workspaces", "workspace_members", "roles"];
const RUNTIME_AND_OWNER_ROLES = [
  "shoutory_owner",
  "shoutory_definer",
  "shoutory_app",
  "shoutory_worker",
  "shoutory_auth",
  "shoutory_readonly",
];
// Tables outside row security on purpose: the migration ledger holds no tenant data.
const RLS_ALLOWLIST = ["schema_migrations"];

interface PolicyRow {
  tbl: string;
  policy: string;
  cmd: string;
  expr: string | null;
}

function purposeProblems(rows: PolicyRow[]): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const row of rows) {
    const purpose = /job_purpose\(\)[^=]*= '([a-z_]+)'/.exec(row.expr ?? "")?.[1];
    if (!purpose) problems.push(`${row.tbl}.${row.policy}: no purpose`);
    const commands = row.cmd === "*" ? ["r", "a", "w", "d"] : [row.cmd];
    for (const command of commands) {
      const key = `${row.tbl}/${purpose}/${command}`;
      const first = seen.get(key);
      if (first) problems.push(`${key}: ${first} and ${row.policy}`);
      seen.set(key, row.policy);
    }
  }
  return problems;
}

describe("row security catalog: definers", () => {
  const owner = useOwnerPool();

  it("the functions owned by the definer role are exactly the definer matrix, at least 11", async () => {
    const found = await owner().query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace
         AND pg_get_userbyid(p.proowner) = 'shoutory_definer' ORDER BY p.proname`,
    );
    const listed = found.rows.map((row) => row.proname as string);
    expect(listed.length).toBeGreaterThanOrEqual(11);
    expect(listed).toEqual(DEFINERS.map((d) => d.name).sort());
  });

  it("no SECURITY DEFINER function anywhere is owned by another role", async () => {
    const found = await owner().query(
      `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname IN ('app', 'auth') AND pg_get_userbyid(p.proowner) <> 'shoutory_definer'`,
    );
    expect(found.rows).toEqual([]);
  });

  it.each(DEFINERS)(
    "$name has one signature, pins its search_path with pg_temp last and has the stated security",
    async (d) => {
      const found = await owner().query(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1`,
        [d.name],
      );
      expect(found.rows).toEqual([
        {
          args: d.args,
          prosecdef: d.helper !== true,
          proconfig: [`search_path=${d.helper ? "pg_catalog, pg_temp" : "pg_catalog, app, pg_temp"}`],
        },
      ]);
    },
  );

  it.each(DEFINERS)(
    "$name is executable by exactly its callers and the definer, never by PUBLIC",
    async (d) => {
      const found = await owner().query(`${GRANTEES} AND p.proname = $2`, ["app", d.name]);
      expect(found.rows.map((row) => row.grantee).sort()).toEqual([...d.callers, "shoutory_definer"].sort());
    },
  );

  // One definer policy per table, purpose and command: a purpose opens exactly the access its function needs.
  it("every policy of the definer role names a purpose, once per table and command", async () => {
    const found = await owner().query(
      `SELECT c.relname AS tbl, p.polname AS policy, p.polcmd AS cmd,
              coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) AS expr
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'app'::regnamespace
         AND (SELECT oid FROM pg_roles WHERE rolname = 'shoutory_definer') = ANY (p.polroles)`,
    );
    expect(purposeProblems(found.rows)).toEqual([]);
  });
});

describe("row security catalog: what the definer role may do to the tenancy tables", () => {
  const owner = useOwnerPool();

  // R199, R240: the definers read and create rows. The only table-level DELETE is a member's removal; an UPDATE is a
  // column grant (a member's role, and the id column that the rank 1a row lock needs), never table-wide.
  it.each([
    ["UPDATE", []],
    ["DELETE", ["workspace_members"]],
    ["TRUNCATE", []],
  ])("the definer role holds %s on a tenancy table only where listed", async (privilege, listed) => {
    const found = await owner().query(
      `SELECT t AS tbl FROM unnest($1::text[]) AS t WHERE has_table_privilege('shoutory_definer', 'app.' || t, $2)`,
      [TENANCY_TABLES, privilege],
    );
    expect(found.rows.map((row) => row.tbl)).toEqual(listed);
  });
});

describe("row security catalog: tables and roles", () => {
  const owner = useOwnerPool();

  it("every app table has row security enabled and forced and a policy", async () => {
    const found = await owner().query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND c.relname <> ALL ($1) ORDER BY c.relname`,
      [RLS_ALLOWLIST],
    );
    expect(found.rows.length).toBeGreaterThanOrEqual(11);
    expect(
      found.rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity || row.policies < 1),
    ).toEqual([]);
  });

  it.each(RUNTIME_AND_OWNER_ROLES)("%s does not bypass row security", async (role) => {
    const found = await owner().query("SELECT rolbypassrls FROM pg_roles WHERE rolname = $1", [role]);
    expect(found.rows).toEqual([{ rolbypassrls: false }]);
  });
});
