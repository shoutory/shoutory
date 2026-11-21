import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../../src/testing/template.js";

const env = readTestEnv();

// Security floor: a session of organization and workspace A sees nothing of B in any tenant table and changes
// nothing of B, whatever the statement. The tenant tables are read from the catalog (an `app` table carrying a
// `w_select` or `o_select` policy, leaf partitions excluded) and every one needs a registry entry below: a new
// tenant table fails this file by name until it is registered. Settings are planted raw on purpose, so a context
// withTenant would refuse can be tried. Two clones serve the whole file: `plain` keeps the migration's grants, and
// `planted` adds write grants on every tenant table so the policies alone must hold.
const OA = randomUUID();
const OB = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const WN = randomUUID();
const WI = randomUUID();
const UA = randomUUID();
const UB = randomUUID();

// A valid built-in role id for the INSERTs, so they test row security and nothing else.
let viewerRole = "";
const BUILTIN = (key: string) => `(SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = '${key}')`;

interface Entry {
  /** The column the row security template keys on. */
  key: string;
  a: string;
  b: string;
  seed: string[];
  /** A statement inserting a row for B (or, for a keyed-by-id table, a row outside A). */
  insertForB: () => string;
  /** Present only for a table with write policies (W): the writes A may make to its own rows. */
  write?: {
    /** A no-op UPDATE of every column it names, so only the rows the policy admits are counted. */
    update: string;
    insertOwn: () => string;
    /** The workspace that is both the read set and the write set for the INSERT, and for the UPDATE and DELETE. */
    insertWs: string;
    changeWs: string;
    /** The key value of the one row A changes and deletes. */
    changeKey: string;
  };
}

const REGISTRY: Record<string, Entry> = {
  "app.organizations": {
    key: "id",
    a: OA,
    b: OB,
    seed: [
      `INSERT INTO app.organizations (id, name, slug, type) VALUES
         ('${OA}', 'org-a', 'org-a', 'team'), ('${OB}', 'org-b', 'org-b', 'team')`,
    ],
    insertForB: () => `INSERT INTO app.organizations (id, name, slug, type)
                 VALUES (gen_random_uuid(), 'org-new', 'org-new', 'team')`,
  },
  "app.organization_members": {
    key: "organization_id",
    a: OA,
    b: OB,
    seed: [
      `INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES
         ('${OA}', '${UA}', 'owner'), ('${OB}', '${UB}', 'owner')`,
    ],
    insertForB: () => `INSERT INTO app.organization_members (organization_id, user_id, org_role)
                 VALUES ('${OB}', '${UA}', 'member')`,
  },
  "app.workspaces": {
    key: "id",
    a: WA,
    b: WB,
    seed: [
      `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES
         ('${WA}', '${OA}', 'ws-a', 'ws-a'), ('${WB}', '${OB}', 'ws-b', 'ws-b'), ('${WN}', '${OA}', 'ws-n', 'ws-n')`,
    ],
    insertForB: () => `INSERT INTO app.workspaces (id, organization_id, name, slug)
                 VALUES (gen_random_uuid(), '${OB}', 'ws-new', 'ws-new')`,
    write: {
      update: "UPDATE app.workspaces SET name = name",
      insertOwn: () =>
        `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ('${WI}', '${OA}', 'ws-i', 'ws-i')`,
      insertWs: WI,
      changeWs: WN,
      changeKey: WN,
    },
  },
  "app.roles": {
    key: "workspace_id",
    a: WA,
    b: WB,
    seed: [
      `INSERT INTO app.roles (workspace_id, key, name, permissions) VALUES
         ('${WA}', 'custom-a', 'Custom A', '{}'), ('${WB}', 'custom-b', 'Custom B', '{}')`,
    ],
    insertForB: () => `INSERT INTO app.roles (workspace_id, key, name, permissions)
                 VALUES ('${WB}', 'custom-new', 'Custom new', '{}')`,
    write: {
      update: "UPDATE app.roles SET name = name",
      insertOwn: () =>
        `INSERT INTO app.roles (workspace_id, key, name, permissions) VALUES ('${WA}', 'custom-own', 'Own', '{}')`,
      insertWs: WA,
      changeWs: WA,
      changeKey: WA,
    },
  },
  "app.workspace_members": {
    key: "workspace_id",
    a: WA,
    b: WB,
    seed: [
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
         VALUES ('${WA}', '${UA}', ${BUILTIN("owner")}), ('${WB}', '${UB}', ${BUILTIN("owner")})`,
    ],
    insertForB: () => `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
                 VALUES ('${WB}', '${UA}', '${viewerRole}')`,
    write: {
      update: "UPDATE app.workspace_members SET status = status",
      insertOwn: () => `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
                  VALUES ('${WA}', '${UB}', '${viewerRole}')`,
      insertWs: WA,
      changeWs: WA,
      changeKey: WA,
    },
  },
};
const invitationRow = (workspace: string, email: string, user: string) =>
  `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, expires_at, invited_by)
   VALUES ('${workspace}', '${email}', ${BUILTIN("viewer")}, sha256(convert_to('${randomUUID()}', 'UTF8')),
     now() + interval '1 day', '${user}')`;
REGISTRY["app.invitations"] = {
  key: "workspace_id",
  a: WA,
  b: WB,
  seed: [invitationRow(WA, "inv-a@example.test", UA), invitationRow(WB, "inv-b@example.test", UB)],
  insertForB: () => invitationRow(WB, "inv-new@example.test", UA),
  write: {
    update: "UPDATE app.invitations SET email = email",
    insertOwn: () => invitationRow(WA, "inv-own@example.test", UA),
    insertWs: WA,
    changeWs: WA,
    changeKey: WA,
  },
};
// The audit log has no write policy at all: its rows come from definers, so only the read and planted-INSERT cases run.
const auditRow = (workspace: string, organization: string, hash: string) =>
  `INSERT INTO app.audit_logs (id, at, workspace_id, organization_id, actor_kind, actor_ref, action, resource_kind,
     resource_id, request_id, ip_hmac, metadata, prev_hash, hash)
   VALUES (gen_random_uuid(), now(), '${workspace}', '${organization}', 'user', '${UA}', 'post.created', 'post',
     '${randomUUID()}', 'req-matrix', NULL, '{}', decode(repeat('00', 32), 'hex'), decode(repeat('${hash}', 32), 'hex'))`;
REGISTRY["app.audit_logs"] = {
  key: "workspace_id",
  a: WA,
  b: WB,
  seed: [auditRow(WA, OA, "01"), auditRow(WB, OB, "02")],
  insertForB: () => auditRow(WB, OB, "03"),
};
// Migration 0013: the channel tables are template W.
const CA = randomUUID();
const CB = randomUUID();
const channelRow = (id: string, workspace: string, account: string) =>
  `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name)
   VALUES ('${id}', '${workspace}', 'fixture-oauth', 'profile', '${account}', 'matrix channel')`;
REGISTRY["app.channels"] = {
  key: "workspace_id",
  a: WA,
  b: WB,
  seed: [channelRow(CA, WA, "acct-a"), channelRow(CB, WB, "acct-b")],
  insertForB: () => channelRow(randomUUID(), WB, "acct-new"),
  // The app role writes only the nickname column; the planted grants let the policies alone be tried. The snapshot and
  // cursor rows of a channel go with it (ON DELETE CASCADE), so deleting A's channels works.
  write: {
    update: "UPDATE app.channels SET nickname = nickname",
    insertOwn: () => channelRow(randomUUID(), WA, "acct-own"),
    insertWs: WA,
    changeWs: WA,
    changeKey: WA,
  },
};
const snapshotRow = (channel: string, workspace: string, epoch: number) =>
  `INSERT INTO app.channel_capability_snapshots
     (workspace_id, channel_id, epoch, manifest_digest, api_version, capabilities, limits, observed_at)
   VALUES ('${workspace}', '${channel}', ${epoch}, 'digest-${epoch}', 'v1', '{}', '{}', now())`;
REGISTRY["app.channel_capability_snapshots"] = {
  key: "workspace_id",
  a: WA,
  b: WB,
  seed: [snapshotRow(CA, WA, 1), snapshotRow(CB, WB, 1)],
  insertForB: () => snapshotRow(CB, WB, 2),
  write: {
    update: "UPDATE app.channel_capability_snapshots SET api_version = api_version",
    insertOwn: () => snapshotRow(CA, WA, 2),
    insertWs: WA,
    changeWs: WA,
    changeKey: WA,
  },
};
const cursorRow = (channel: string, workspace: string, stream: string) =>
  `INSERT INTO app.sync_cursors (workspace_id, channel_id, stream, cursor, synced_at, next_sync_at)
   VALUES ('${workspace}', '${channel}', '${stream}', 'c-1', now(), now())`;
REGISTRY["app.sync_cursors"] = {
  key: "workspace_id",
  a: WA,
  b: WB,
  seed: [cursorRow(CA, WA, "comments"), cursorRow(CB, WB, "comments")],
  insertForB: () => cursorRow(CB, WB, "mentions"),
  write: {
    update: "UPDATE app.sync_cursors SET cursor = cursor",
    insertOwn: () => cursorRow(CA, WA, "mentions"),
    insertWs: WA,
    changeWs: WA,
    changeKey: WA,
  },
};
const TABLES = Object.keys(REGISTRY);
const WRITABLE = TABLES.filter((table) => REGISTRY[table]?.write);

type Settings = Record<string, string>;
const contextA: Settings = {
  "app.organization_id": OA,
  "app.workspace_ids": `{${WA}}`,
  "app.write_workspace_id": WA,
  "app.principal_kind": "user",
  "app.principal_id": UA,
};
/** A's context with `workspace` as the write workspace, also in the read set. */
const writingTo = (workspace: string): Settings => ({
  ...contextA,
  "app.workspace_ids": `{${WA},${workspace}}`,
  "app.write_workspace_id": workspace,
});

// Contexts that must read and change nothing; undefined plants no setting at all.
const HOSTILE: [string, Settings | undefined][] = [
  ["a missing context", undefined],
  ["an empty context", { "app.organization_id": "", "app.workspace_ids": "", "app.write_workspace_id": "" }],
  [
    "a forged context",
    {
      "app.organization_id": "not-a-uuid",
      "app.workspace_ids": `{${WA},forged}`,
      "app.write_workspace_id": `${WA}; DROP TABLE app.roles`,
      "app.principal_kind": "user",
    },
  ],
  ["a portal principal", { ...contextA, "app.principal_kind": "portal" }],
  [
    "an organization context without a workspace",
    { "app.organization_id": OA, "app.principal_kind": "user" },
  ],
];

async function inTransaction(pool: Pool, settings: Settings, sql: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    return await client.query(sql);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function seed(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO auth."user" (id, name, email) VALUES
       ('${UA}', 'matrix-a', 'matrix-a@example.test'), ('${UB}', 'matrix-b', 'matrix-b@example.test')`,
  );
  // Parents first: the tables that others point at.
  const order = [
    "app.organizations",
    "app.organization_members",
    "app.workspaces",
    "app.roles",
    "app.workspace_members",
    "app.invitations",
    "app.audit_logs",
    "app.channels",
    "app.channel_capability_snapshots",
    "app.sync_cursors",
  ];
  for (const table of order) for (const sql of REGISTRY[table]?.seed ?? []) await admin.query(sql);
  const viewer = await admin.query("SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'viewer'");
  viewerRole = viewer.rows[0].id;
}

let plain: TestDatabase;
let planted: TestDatabase;
beforeAll(async () => {
  for (const withGrants of [false, true]) {
    const db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await withAdminClient(env, db.name, async (admin) => {
      await seed(admin);
      if (withGrants)
        await admin.query(`GRANT INSERT, UPDATE, DELETE ON ${TABLES.join(", ")} TO shoutory_app`);
    });
    if (withGrants) planted = db;
    else plain = db;
  }
});
afterAll(async () => {
  await Promise.all([plain?.drop(), planted?.drop()]);
});

const plainApp = () => plain.pool("app");
const plantedApp = () => planted.pool("app");

async function tenantTables(pool: Pool): Promise<string[]> {
  const found = await pool.query(
    `SELECT DISTINCT c.oid::regclass::text AS name FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'app'::regnamespace AND NOT c.relispartition AND p.polname IN ('w_select', 'o_select')`,
  );
  return found.rows.map((row) => row.name as string).sort();
}

describe("tenant tables", () => {
  it("the catalog lists at least 3 tenant tables and every one is registered", async () => {
    const listed = await tenantTables(plain.pool("owner"));
    expect(listed.length).toBeGreaterThanOrEqual(3);
    expect(listed).toEqual([...TABLES].sort());
  });
});

describe("A sees zero rows of B in every tenant table", () => {
  it.each(TABLES)("%s: SELECT of B's rows returns 0 rows (RLS)", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const sql = `SELECT 1 FROM ${table} WHERE ${entry.key} = '${entry.b}'`;
    expect((await inTransaction(plainApp(), contextA, sql)).rows).toHaveLength(0);
  });

  it.each(TABLES)("%s: A reads its own rows (positive control)", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const sql = `SELECT 1 FROM ${table} WHERE ${entry.key} = '${entry.a}'`;
    expect((await inTransaction(plainApp(), contextA, sql)).rows.length).toBeGreaterThanOrEqual(1);
  });

  it("A reads the five built-in roles", async () => {
    const sql = "SELECT count(*)::int AS n FROM app.roles WHERE workspace_id IS NULL";
    expect((await inTransaction(plainApp(), contextA, sql)).rows[0].n).toBe(5);
  });
});

describe("planted write grants: the policies alone keep A out of B", () => {
  it.each(TABLES)("%s: INSERT for B is refused with 42501 (RLS)", async (table) => {
    const run = inTransaction(plantedApp(), contextA, (REGISTRY[table] as Entry).insertForB());
    await expect(run).rejects.toMatchObject({ code: "42501" });
  });

  // A workspace table refuses the move by WITH CHECK. An organization table has no write policy at all, so its
  // refusal is the missing policy and is covered by the planted-grant INSERT above.
  it.each(WRITABLE)("%s: moving A's own row to B is refused (RLS)", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const sql = `UPDATE ${table} SET ${entry.key} = '${entry.b}' WHERE ${entry.key} = '${entry.a}'`;
    await expect(inTransaction(plantedApp(), contextA, sql)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(WRITABLE)("%s: UPDATE of B's rows touches 0 rows (RLS)", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const sql = `${entry.write?.update} WHERE ${entry.key} = '${entry.b}'`;
    expect((await inTransaction(plantedApp(), contextA, sql)).rowCount).toBe(0);
  });

  it.each(TABLES)("%s: DELETE of B's rows touches 0 rows (RLS)", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const sql = `DELETE FROM ${table} WHERE ${entry.key} = '${entry.b}'`;
    expect((await inTransaction(plantedApp(), contextA, sql)).rowCount).toBe(0);
  });
});

// The positive control of the write policies: if they refused every write, the cases above would pass for nothing.
describe("planted write grants: A changes its own rows", () => {
  it.each(WRITABLE)("%s: INSERT into A succeeds", async (table) => {
    const write = (REGISTRY[table] as Entry).write as NonNullable<Entry["write"]>;
    const run = await inTransaction(plantedApp(), writingTo(write.insertWs), write.insertOwn());
    expect(run.rowCount).toBe(1);
  });

  it.each(WRITABLE)("%s: UPDATE of A's own row touches 1 row", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const write = entry.write as NonNullable<Entry["write"]>;
    const sql = `${write.update} WHERE ${entry.key} = '${write.changeKey}'`;
    expect((await inTransaction(plantedApp(), writingTo(write.changeWs), sql)).rowCount).toBe(1);
  });

  it.each(WRITABLE)("%s: DELETE of A's own row touches 1 row", async (table) => {
    const entry = REGISTRY[table] as Entry;
    const write = entry.write as NonNullable<Entry["write"]>;
    const sql = `DELETE FROM ${table} WHERE ${entry.key} = '${write.changeKey}'`;
    expect((await inTransaction(plantedApp(), writingTo(write.changeWs), sql)).rowCount).toBe(1);
  });
});

describe("planted write grants: built-in roles and hostile contexts", () => {
  // The built-in roles (workspace_id NULL) are readable and never writable by the app role.
  it.each([
    [
      "INSERT",
      "INSERT INTO app.roles (workspace_id, key, name, permissions) VALUES (NULL, 'forged', 'F', '{}')",
      "refused",
    ],
    ["UPDATE", "UPDATE app.roles SET name = 'forged' WHERE workspace_id IS NULL", 0],
    ["DELETE", "DELETE FROM app.roles WHERE workspace_id IS NULL", 0],
  ] as const)("a built-in role cannot be changed by shoutory_app: %s", async (_verb, sql, expected) => {
    const run = inTransaction(plantedApp(), contextA, sql);
    if (expected === "refused") await expect(run).rejects.toMatchObject({ code: "42501" });
    else expect((await run).rowCount).toBe(expected);
  });

  // Only the tables with write policies: an organization table refuses every write for having none, whatever the
  // context, so its answer here would not depend on the context.
  it.each(HOSTILE.flatMap(([title, settings]) => WRITABLE.map((table) => [title, settings, table] as const)))(
    "%s changes nothing in %s",
    async (_title, settings, table) => {
      const entry = REGISTRY[table] as Entry;
      const insert = inTransaction(
        plantedApp(),
        settings ?? {},
        entry.insertForB().replace(entry.b, entry.a),
      );
      await expect(insert).rejects.toMatchObject({ code: "42501" });
      const update = `${entry.write?.update} WHERE true`;
      expect((await inTransaction(plantedApp(), settings ?? {}, update)).rowCount).toBe(0);
      expect((await inTransaction(plantedApp(), settings ?? {}, `DELETE FROM ${table}`)).rowCount).toBe(0);
    },
  );
});

describe("empty, forged and missing context reads nothing", () => {
  it.each(HOSTILE.flatMap(([title, settings]) => TABLES.map((table) => [title, settings, table] as const)))(
    "%s reads 0 rows of %s",
    async (_title, settings, table) => {
      const sql = `SELECT count(*)::int AS n FROM ${table}`;
      const counted = await inTransaction(plainApp(), settings ?? {}, sql);
      // An organization context alone still reads its organization tables: O is keyed on the organization.
      const orgOnly = settings?.["app.organization_id"] === OA && settings["app.principal_kind"] === "user";
      const orgTable = table === "app.organizations" || table === "app.organization_members";
      expect(counted.rows[0].n).toBe(orgOnly && orgTable ? 1 : 0);
    },
  );
});
