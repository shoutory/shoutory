import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

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
const APP_WORKER = ["shoutory_app", "shoutory_worker"];
const SEALED_FIELDS =
  "format_version integer, key_id text, iv bytea, ciphertext bytea, auth_tag bytea, wrap_iv bytea, wrap_tag bytea, wrapped_dek bytea";
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
    // No code calls it from the worker; a later slice that needs it grants it with its own test (R532 (2)).
    callers: ["shoutory_app"],
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
    args: "organization_id uuid, name text, slug text, tz text, request_id text, ip_hmac bytea, bucket_key text",
    callers: ["shoutory_app"],
  },
  {
    name: "organization_create",
    args: "name text, type text, request_id text, ip_hmac bytea, bucket_key text",
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
  // 0013
  {
    name: "channel_disable",
    args: "workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "channel_enable",
    args: "workspace_id uuid, channel_id uuid, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  // 0014: the credential definers run for the app role (a user with channels.manage) and the worker (a job principal);
  // the helper carries the one principal check (R537 (2), R539 (10)).
  { name: "credential_caller", args: "workspace_id uuid", callers: [], helper: true },
  { name: "workspace_salt_ensure", args: "workspace_id uuid, salt bytea", callers: APP_WORKER },
  {
    name: "channel_connect",
    args: "workspace_id uuid, provider_id text, account_kind text, provider_account_id text, instance_host text, display_name text, handle text, avatar text, reconnect_channel_id uuid, request_id text, ip_hmac bytea",
    callers: APP_WORKER,
  },
  {
    name: "credential_put",
    args: `workspace_id uuid, channel_id uuid, expected_generation integer, ${SEALED_FIELDS}, access_expires_at timestamp with time zone, refresh_expires_at timestamp with time zone, refresh_token_digest text, manifest_digest text, api_version text, sunset_at timestamp with time zone, capabilities jsonb, limits jsonb, request_id text, ip_hmac bytea`,
    callers: APP_WORKER,
  },
  { name: "credential_open", args: "workspace_id uuid, channel_id uuid", callers: APP_WORKER },
  {
    name: "credential_refresh_begin",
    args: "workspace_id uuid, channel_id uuid, lease_owner text, lease_seconds integer",
    callers: APP_WORKER,
  },
  {
    name: "credential_refresh_commit",
    args: `workspace_id uuid, channel_id uuid, expected_digest text, expected_generation integer, expected_fencing integer, ${SEALED_FIELDS}, access_expires_at timestamp with time zone, refresh_expires_at timestamp with time zone, refresh_token_digest text`,
    callers: APP_WORKER,
  },
  {
    name: "credential_refresh_fail",
    args: "workspace_id uuid, channel_id uuid, expected_digest text, expected_fencing integer, outcome text, state_reason text",
    callers: APP_WORKER,
  },
  { name: "due_token_refreshes", args: "lim integer, margin_seconds integer", callers: ["shoutory_worker"] },
  {
    name: "channel_health_record",
    args: "workspace_id uuid, channel_id uuid, health text, manifest_digest text, api_version text, sunset_at timestamp with time zone, capabilities jsonb, limits jsonb",
    callers: APP_WORKER,
  },
  // 0015: the connect state is written and taken by a signed-in user only, so the app role alone may call them.
  {
    name: "oauth_flow_put",
    args: `flow_id uuid, workspace_id uuid, provider_id text, state_hash bytea, channel_id uuid, instance_host text, ${SEALED_FIELDS}, request_uri text`,
    callers: ["shoutory_app"],
  },
  {
    name: "oauth_flow_take",
    args: "state_digest bytea, want_provider text, want_host text, request_id text, ip_hmac bytea",
    callers: ["shoutory_app"],
  },
  // A job principal (the Telegram poller) or an Admin user takes a connect word, like the credential definers.
  {
    name: "connect_challenge_take",
    args: "workspace_id uuid, provider_id text, code_hash bytea",
    callers: APP_WORKER,
  },
  // 0016 (R551): the media writers. One principal helper (a rank argument, no lock) and the immutability guard.
  {
    name: "media_caller",
    args: "workspace_id uuid, min_rank integer, job_ok boolean",
    callers: [],
    helper: true,
  },
  { name: "media_guard", args: "", callers: [], helper: true },
  {
    name: "media_register",
    args: "workspace_id uuid, file_name text, mime text, source text, source_ref text, multipart_upload_id text, part_size integer",
    callers: ["shoutory_app"],
  },
  {
    name: "media_mark_uploaded",
    args: "workspace_id uuid, asset_id uuid, digest bytea, byte_size bigint, mime text",
    callers: ["shoutory_app"],
  },
  {
    name: "media_advance",
    args: "workspace_id uuid, asset_id uuid, from_state text, to_state text, reject_reason text, facts jsonb",
    callers: APP_WORKER,
  },
  {
    name: "media_derivative_put",
    args: "workspace_id uuid, asset_id uuid, profile text, state text, digest bytea, byte_size bigint, error text",
    callers: ["shoutory_worker"],
  },
  {
    name: "media_upload_progress",
    args: "workspace_id uuid, asset_id uuid, parts_done integer[]",
    callers: APP_WORKER,
  },
  {
    name: "media_set_metadata",
    args: "workspace_id uuid, asset_id uuid, file_name text, tags text[], in_library boolean",
    callers: ["shoutory_app"],
  },
  { name: "media_object_removed", args: "workspace_id uuid, asset_id uuid", callers: ["shoutory_worker"] },
  { name: "media_gc_candidates", args: "lim integer", callers: ["shoutory_worker"] },
  // 0019: the two trigger functions of the ledger. They run for whoever writes an operation, and no role calls them.
  { name: "ledger_guard", args: "", callers: [] },
  { name: "ledger_settled_guard", args: "", callers: [] },
  // 0020 (R590, R591): the writers of the ledger. The insert has no runtime caller (admission and the resolutions call it
  // as the definer role); the fenced move is the worker's; the helper stores evidence inside its callers' purposes.
  {
    name: "ledger_add_evidence",
    args: "workspace_id uuid, operation_id uuid, part integer, kind text, level text, outcome_kind text, refs jsonb",
    callers: [],
    helper: true,
  },
  {
    name: "record_evidence",
    args: "workspace_id uuid, operation_id uuid, kind text, level text, outcome_kind text, refs jsonb",
    callers: ["shoutory_worker"],
  },
  // 0021: the runtime of the ledger. Each runs for a worker job under the ledger purpose; the helper is their caller check.
  { name: "ledger_caller", args: "", callers: [], helper: true },
  { name: "admit_due_targets", args: "p_limit integer, p_providers jsonb", callers: ["shoutory_worker"] },
  {
    name: "claim_operations",
    args: "p_queue text, p_limit integer, p_owner text",
    callers: ["shoutory_worker"],
  },
  {
    name: "bucket_take_scoped",
    args: "p_key text, p_scope text, p_capacity integer, p_window_seconds integer, p_cost integer",
    callers: ["shoutory_worker"],
  },
  {
    name: "bucket_pause",
    args: "p_key text, p_scope text, p_until timestamp with time zone, p_reason text",
    callers: ["shoutory_worker"],
  },
  { name: "sweep_expired_leases", args: "p_providers jsonb", callers: ["shoutory_worker"] },
  { name: "sweep_due_moves", args: "p_live_providers jsonb", callers: ["shoutory_worker"] },
  { name: "ledger_due_move", args: "p_ws uuid, p_id uuid", callers: [], helper: true },
  // 0022: the effect SQL. The lock helpers, the rollup and the two triggers are called by the definers and by the
  // table's own triggers; the attempt writers are the worker's, the resolution is a signed-in person's.
  { name: "ledger_prelock", args: "p_ws uuid, p_op uuid", callers: [], helper: true },
  {
    name: "ledger_lock_target",
    args: "p_ws uuid, p_op uuid, p_state text, p_token bigint",
    callers: [],
    helper: true,
  },
  { name: "ledger_rollup", args: "p_ws uuid, p_variant uuid, p_fired text", callers: [], helper: true },
  { name: "operations_rollup", args: "", callers: [] },
  { name: "operations_usage", args: "", callers: [] },
  {
    name: "operation_attempt_start",
    args: "p_ws uuid, p_op uuid, p_token bigint, p_owner text, p_step text, p_quotas jsonb",
    callers: ["shoutory_worker"],
  },
  {
    name: "operation_attempt_finish",
    args: "p_ws uuid, p_attempt uuid, p_token bigint, p_result jsonb",
    callers: ["shoutory_worker"],
  },
  {
    name: "operation_record_progress",
    args: "p_ws uuid, p_op uuid, p_token bigint, p_cursor text, p_refs jsonb",
    callers: ["shoutory_worker"],
  },
  {
    name: "resolve_operation",
    args: "p_ws uuid, p_op uuid, p_kind text, p_args jsonb",
    callers: ["shoutory_app"],
  },
  { name: "ledger_state_counts", args: "", callers: ["shoutory_app"] },
  {
    name: "claim_polls",
    args: "p_queue text, p_limit integer, p_owner text, p_lease_seconds integer",
    callers: ["shoutory_worker"],
  },
  {
    name: "claim_reconciles",
    args: "p_queue text, p_limit integer, p_owner text, p_lease_seconds integer, p_class_e_kinds text[]",
    callers: ["shoutory_worker"],
  },
  {
    name: "heartbeat",
    args: "p_id uuid, p_token bigint, p_owner text, p_extend_seconds integer",
    callers: ["shoutory_worker"],
  },
  { name: "operation_cancel", args: "workspace_id uuid, operation_id uuid", callers: ["shoutory_app"] },
  { name: "operation_insert", args: "workspace_id uuid, fields jsonb, actor text", callers: [] },
  {
    name: "operation_transition",
    args: "workspace_id uuid, operation_id uuid, token bigint, from_state text, to_state text, actor text, changes jsonb",
    callers: ["shoutory_worker"],
  },
  // 0018 (R574, R575): the post writers, for a signed-in Editor or above through the app role only, and the internal
  // helper that rebuilds the variants and media from a draft (no runtime role runs it).
  {
    name: "post_apply_draft",
    args: "workspace_id uuid, post_id uuid, draft jsonb",
    callers: [],
    helper: true,
  },
  // The helper the autosave, save and restore definers share: lock, compare, version, draft and pointer move.
  {
    name: "post_write_version",
    args: "workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea, kind text",
    callers: [],
    helper: true,
  },
  {
    name: "post_create",
    args: "workspace_id uuid, snapshot jsonb, snapshot_hash bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "post_autosave",
    args: "workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "post_save",
    args: "workspace_id uuid, post_id uuid, expected_version uuid, snapshot jsonb, snapshot_hash bytea",
    callers: ["shoutory_app"],
  },
  {
    name: "post_restore",
    args: "workspace_id uuid, post_id uuid, expected_version uuid, source_version uuid",
    callers: ["shoutory_app"],
  },
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

// R499, R532 (1): a leaf read by name never passes through the parent's policies (PostgreSQL ddl-inherit), so each
// leaf has row security enabled and forced and, with no policy of its own, denies a direct read to every role. The
// leaves of 0008 and the one `ensure_partitions` makes are both covered; the parent's own path must keep working.
describe("row security catalog: audit_logs leaves", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await db.pool("worker").query("SELECT app.ensure_partitions()");
  });
  afterAll(() => db.drop());

  it("every audit_logs leaf has row security enabled and forced and no policy, 0008 leaves and a new one", async () => {
    const found = await db.pool("owner").query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'app.audit_logs'::regclass ORDER BY c.relname`,
    );
    expect(found.rows.length).toBeGreaterThanOrEqual(4);
    expect(found.rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity)).toEqual([]);
    expect(found.rows.filter((row) => row.policies > 0)).toEqual([]);
  });

  // The owner of the leaf is the definer role: with FORCE it reads a leaf by name through no policy and sees nothing,
  // while the parent's purpose policy still shows the row it holds. Without FORCE the owner would see it.
  it("the definer role reads 1 row through the parent and 0 rows from the leaf by name", async () => {
    const counts = await withAdminClient(env, db.name, async (admin) => {
      await admin.query(
        `INSERT INTO app.audit_logs (id, at, actor_kind, actor_ref, action, resource_kind, resource_id,
           request_id, metadata, prev_hash, hash)
         VALUES (gen_random_uuid(), now(), 'user', 'leaf-test', 'post.created', 'post', 'leaf-1', 'req-leaf', '{}',
           decode(repeat('00', 32), 'hex'), decode(repeat('0a', 32), 'hex'))`,
      );
      const leaf = (await admin.query("SELECT tableoid::regclass::text AS name FROM app.audit_logs LIMIT 1"))
        .rows[0].name as string;
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE shoutory_definer");
      await admin.query("SELECT set_config('app.job_purpose', 'audit_chain_check', true)");
      const viaParent = await admin.query("SELECT count(*)::int AS n FROM app.audit_logs");
      const viaLeaf = await admin.query(`SELECT count(*)::int AS n FROM ${leaf}`);
      await admin.query("ROLLBACK");
      return { parent: viaParent.rows[0].n, leaf: viaLeaf.rows[0].n };
    });
    expect(counts).toEqual({ parent: 1, leaf: 0 });
  });
});
