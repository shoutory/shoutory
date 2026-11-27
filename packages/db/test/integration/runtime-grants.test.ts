import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Column privileges are read as well: a column grant on a key column would let the app role move a row between tenants.
const RUNTIME_ROLES = ["shoutory_app", "shoutory_worker", "shoutory_auth", "shoutory_readonly"];
const CEILING: Record<string, string[]> = {
  W: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  O: ["SELECT"],
  U: ["SELECT"],
  none: [],
};
const READ = ["SELECT"];

const EXACT: Record<string, Record<string, string[]>> = {
  schema_migrations: { shoutory_app: READ, shoutory_worker: READ },
  user_profiles: { shoutory_app: READ, shoutory_worker: READ },
  session_step_ups: { shoutory_app: READ, shoutory_worker: READ },
  rate_buckets: {},
  instance_admins: {},
  instance_settings: {},
  feature_flags: {},
  feature_flag_overrides: {},
  email_outbox: {},
  organizations: { shoutory_app: READ },
  organization_members: { shoutory_app: READ },
  workspaces: { shoutory_app: READ },
  workspace_members: { shoutory_app: READ },
  invitations: {},
  roles: { shoutory_app: READ },
  audit_logs: { shoutory_app: READ },
  audit_heads: {},
  channels: { shoutory_app: READ },
  channel_capability_snapshots: { shoutory_app: READ },
  sync_cursors: { shoutory_app: READ },
  provider_apps: {},
  provider_instance_apps: {},
  channel_credentials: {},
  workspace_key_salts: {},
  oauth_flows: {},
  connect_challenges: {},
  bot_claims: {},
  media_assets: { shoutory_app: READ, shoutory_worker: READ },
  media_uploads: { shoutory_app: READ, shoutory_worker: READ },
  media_derivatives: { shoutory_app: READ, shoutory_worker: READ },
  posts: { shoutory_app: READ, shoutory_worker: READ },
  post_versions: { shoutory_app: READ, shoutory_worker: READ },
  post_variants: { shoutory_app: READ, shoutory_worker: READ },
  post_media: { shoutory_app: READ, shoutory_worker: READ },
  idempotency_keys: {},
  operations: { shoutory_app: READ, shoutory_worker: READ },
  operation_media: { shoutory_app: READ, shoutory_worker: READ },
  operation_attempts: { shoutory_app: READ, shoutory_worker: READ },
  operation_evidence: { shoutory_app: READ, shoutory_worker: READ },
  operation_resolutions: { shoutory_app: READ, shoutory_worker: READ },
  usage_reservations: {},
  ledger_transitions: {},
};
const COLUMN_GRANTS = [
  "shoutory_app workspaces.name UPDATE",
  "shoutory_app workspaces.slug UPDATE",
  "shoutory_app workspaces.colour UPDATE",
  "shoutory_app workspaces.default_tz UPDATE",
  // A channel's nickname is the one column the app role writes; connection_state and state_reason have
  // no runtime UPDATE grant, so a state can only come from a definer that checks the move.
  "shoutory_app channels.nickname UPDATE",
  // The worker reads the seven columns of a channel it needs to act on an operation: no secret and no display column.
  ...[
    "id",
    "workspace_id",
    "provider_id",
    "provider_account_id",
    "instance_host",
    "connection_state",
    "capability_epoch",
  ].map((column) => `shoutory_worker channels.${column} SELECT`),
  // The digest of an invitation is the one column the app role never reads.
  ...[
    "id",
    "workspace_id",
    "email",
    "role_id",
    "expires_at",
    "accepted_at",
    "accepted_by",
    "revoked_at",
    "invited_by",
  ].map((column) => `shoutory_app invitations.${column} SELECT`),
];

interface Held {
  tbl: string;
  role: string;
  priv: string;
}

async function templateOf(pool: Pool, table: string): Promise<string> {
  const found = await pool.query(
    `SELECT p.polname FROM pg_policy p WHERE p.polrelid = ('app.' || quote_ident($1))::regclass
       AND p.polname IN ('w_select', 'o_select', 'u_select')`,
    [table],
  );
  const names = found.rows.map((row) => row.polname as string);
  const match = ["w_select", "o_select", "u_select"].find((name) => names.includes(name));
  return match ? (match[0] as string).toUpperCase() : "none";
}

async function tableGrants(pool: Pool): Promise<{ present: string[]; held: Held[] }> {
  const held = await pool.query(
    `SELECT c.relname AS tbl, coalesce(r.rolname, 'PUBLIC') AS role, a.privilege_type AS priv
     FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND (r.rolname = ANY ($1) OR a.grantee = 0)`,
    [RUNTIME_ROLES],
  );
  const present = await pool.query(
    `SELECT c.relname AS tbl FROM pg_class c
     WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
  );
  return { present: present.rows.map((row) => row.tbl as string), held: held.rows as Held[] };
}

function oneTable(tbl: string, mine: Held[], ceiling: string[]): string[] {
  const exact = EXACT[tbl];
  const extra = mine
    .filter((row) => !(exact ? (exact[row.role] ?? []) : ceiling).includes(row.priv))
    .map((row) => `app.${tbl} ${row.role} ${row.priv}`);
  const wanted = Object.entries(exact ?? {}).flatMap(([role, privileges]) =>
    privileges.map((priv) => ({ role, priv })),
  );
  const missing = wanted
    .filter(({ role, priv }) => !mine.some((row) => row.role === role && row.priv === priv))
    .map(({ role, priv }) => `app.${tbl} ${role} lacks ${priv}`);
  return [...extra, ...missing];
}

async function tableViolations(pool: Pool): Promise<string[]> {
  const { present, held } = await tableGrants(pool);
  const problems = Object.keys(EXACT)
    .filter((tbl) => !present.includes(tbl))
    .map((tbl) => `app.${tbl} is missing`);
  for (const tbl of present) {
    const ceiling = CEILING[await templateOf(pool, tbl)] as string[];
    const mine = held.filter((row) => row.tbl === tbl);
    problems.push(...oneTable(tbl, mine, ceiling));
  }
  return problems;
}

async function columnViolations(pool: Pool): Promise<string[]> {
  const found = await pool.query(
    `SELECT r.rolname || ' ' || c.relname || '.' || att.attname || ' ' || a.privilege_type AS grant
     FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
     CROSS JOIN LATERAL aclexplode(att.attacl) a JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.relnamespace = 'app'::regnamespace AND att.attacl IS NOT NULL AND r.rolname = ANY ($1)`,
    [RUNTIME_ROLES],
  );
  const held = found.rows.map((row) => row.grant as string);
  return [
    ...held.filter((grant) => !COLUMN_GRANTS.includes(grant)).map((grant) => `column ${grant}`),
    ...COLUMN_GRANTS.filter((grant) => !held.includes(grant)).map((grant) => `column ${grant} is missing`),
  ];
}

async function grantViolations(pool: Pool): Promise<string[]> {
  return [...(await tableViolations(pool)), ...(await columnViolations(pool))].sort();
}

function useClone(plant?: (admin: Client) => Promise<void>): () => TestDatabase {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    if (plant) await withAdminClient(env, db.name, plant);
  });
  afterAll(() => db.drop());
  return () => db;
}

describe("runtime role grants", () => {
  const clone = useClone();

  it("the runtime roles hold nothing beyond the template allowance and the exact table grants", async () => {
    expect(await grantViolations(clone().pool("owner"))).toEqual([]);
  });
});

describe("runtime role grants: a planted table grant is reported", () => {
  const clone = useClone(async (admin) => {
    await admin.query("CREATE TABLE app.fx_grants (workspace_id uuid NOT NULL)");
    await admin.query("SELECT app.apply_rls_template('app.fx_grants'::regclass, 'W')");
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON app.fx_grants TO shoutory_app");
  });

  it("TRUNCATE beyond the workspace-table grants is a violation", async () => {
    expect(await grantViolations(clone().pool("owner"))).toContain("app.fx_grants shoutory_app TRUNCATE");
  });
});

describe("runtime role grants: a planted column grant is reported", () => {
  const clone = useClone(async (admin) => {
    await admin.query("GRANT UPDATE (organization_id) ON app.workspaces TO shoutory_app");
  });

  it("UPDATE on workspaces.organization_id is a violation", async () => {
    expect(await grantViolations(clone().pool("owner"))).toContain(
      "column shoutory_app workspaces.organization_id UPDATE",
    );
  });
});
