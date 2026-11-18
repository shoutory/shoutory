import { randomUUID } from "node:crypto";
import type { Client, Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withTenant } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { HASH_BAD, holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Security floor of the audit log: rows are written only by the definers, the database refuses every change to a
// written row, one chain per (workspace, UTC day) links the rows by hash, and a reader sees only its own workspace.
const OA = randomUUID();
const OB = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const UA = randomUUID();
const GENESIS = Buffer.alloc(32);
const RUNTIME_ROLES = ["shoutory_app", "shoutory_worker", "shoutory_auth", "shoutory_readonly"];
const TODAY = "(now() AT TIME ZONE 'UTC')::date";
const LEAVES = "SELECT inhrelid FROM pg_inherits WHERE inhparent = 'app.audit_logs'::regclass";

const ctxOf = (workspace: string, organization = OA) =>
  ({
    organizationId: organization,
    workspaceIds: [workspace],
    writeWorkspaceId: workspace,
    principalKind: "user",
    principalId: UA,
  }) as const;
const ctxA = ctxOf(WA);

interface Fixture {
  db: () => TestDatabase;
  /** The rows of one statement, run as the superuser: the runtime roles cannot read the audit tables. */
  rows: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  admin: <T>(run: (client: Client) => Promise<T>) => Promise<T>;
}

/** One clone with two organizations, a workspace each and one user. */
function useDatabase(): Fixture {
  let db: TestDatabase;
  const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await admin(async (a) => {
      await a.query(
        `INSERT INTO auth."user" (id, name, email) VALUES ('${UA}', 'audit-a', 'audit-a@example.test')`,
      );
      await a.query(
        `INSERT INTO app.organizations (id, name, slug, type) VALUES
           ('${OA}', 'org-a', 'org-a', 'team'), ('${OB}', 'org-b', 'org-b', 'team')`,
      );
      await a.query(
        `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES
           ('${WA}', '${OA}', 'ws-a', 'ws-a'), ('${WB}', '${OB}', 'ws-b', 'ws-b')`,
      );
    });
  });
  afterAll(() => db.drop());
  const rows = (sql: string, params?: unknown[]) => admin(async (a) => (await a.query(sql, params)).rows);
  return { db: () => db, rows, admin };
}

const AUDIT = "SELECT app.audit_insert($1, 'post', $2, 'req-1', $3, $4)";
const writeAudit = (pool: Pool, ctx: Parameters<typeof withTenant>[1], action = "post.created") =>
  withTenant(pool, ctx, (tx) =>
    tx.query(AUDIT, [action, randomUUID(), Buffer.alloc(32, 7), JSON.stringify({ note: "audit-test" })]),
  );
const writeInstance = (pool: Pool) =>
  pool.query("SELECT app.audit_insert_instance('auth.sign_in', 'user', $1, 'req-2', NULL, '{}')", [UA]);

const CHAIN = `SELECT workspace_id, at, prev_hash, hash FROM app.audit_logs
               WHERE workspace_id IS NOT DISTINCT FROM $1 ORDER BY at, id`;

describe("writes and who may make them", () => {
  const t = useDatabase();
  const app = () => t.db().pool("app");

  it("audit_insert writes a workspace row from the caller's context, audit_insert_instance an instance row", async () => {
    await writeAudit(app(), ctxA);
    await writeInstance(t.db().pool("auth"));
    const rows = await t.rows(
      `SELECT workspace_id, organization_id, actor_kind, actor_ref, action FROM app.audit_logs
       ORDER BY workspace_id NULLS LAST`,
    );
    const instance = { workspace_id: null, organization_id: null, actor_ref: UA, action: "auth.sign_in" };
    expect(rows).toEqual([
      { workspace_id: WA, organization_id: OA, actor_kind: "user", actor_ref: UA, action: "post.created" },
      { ...instance, actor_kind: "user" },
    ]);
  });

  it("a direct INSERT by the app role is refused", async () => {
    const run = app().query("INSERT INTO app.audit_logs (workspace_id) VALUES ($1)", [WA]);
    await expect(run).rejects.toMatchObject({ code: "42501" });
  });

  // R181: the workspace, organization and actor are never arguments, so none can be forged.
  it.each([
    ["B's workspace from an A context", { ...ctxA, writeWorkspaceId: WB }],
    ["no write workspace", { ...ctxA, writeWorkspaceId: undefined }],
    ["no principal", { ...ctxA, principalKind: undefined, principalId: undefined }],
  ] as const)("audit_insert is refused with 42501 for %s", async (_title, ctx) => {
    await expect(writeAudit(app(), ctx)).rejects.toMatchObject({ code: "42501" });
  });

  // R180: the database checks the shape of an action code only, never the closed list.
  it.each([
    ["uppercase", "Workspace.create"],
    ["no dot", "workspace"],
    ["an empty segment", "workspace."],
    ["65 characters", `${"a".repeat(60)}.bcde`],
  ])("an action code with %s is refused with 23514 and no row is written", async (_title, action) => {
    await expect(writeAudit(app(), ctxA, action)).rejects.toMatchObject({ code: "23514" });
    expect(await t.rows("SELECT count(*)::int AS n FROM app.audit_logs WHERE action = $1", [action])).toEqual(
      [{ n: 0 }],
    );
  });

  it("an action code of exactly 64 characters is accepted", async () => {
    await writeAudit(app(), ctxA, `${"a".repeat(59)}.bcde`);
    expect(await t.rows("SELECT length(action) AS n FROM app.audit_logs WHERE action LIKE 'aaaa%'")).toEqual([
      { n: 64 },
    ]);
  });
});

describe("the database refuses every change to a written row", () => {
  const t = useDatabase();
  let leaf = "";
  beforeAll(async () => {
    await writeAudit(t.db().pool("app"), ctxA);
    leaf = (await t.rows(`SELECT inhrelid::regclass::text AS name FROM (${LEAVES}) l ORDER BY 1 LIMIT 1`))[0]
      ?.name as string;
  });
  const insertOnly = { code: "55000", message: expect.stringMatching(/insert-only/) };

  // R183: the superuser client, so the trigger and not row security is what refuses.
  it.each([
    ["UPDATE", "UPDATE app.audit_logs SET action = 'post.deleted'"],
    ["DELETE", "DELETE FROM app.audit_logs"],
  ])(
    "%s is refused by the trigger, also under replica mode, and the row is unchanged",
    async (_verb, sql) => {
      const before = await t.rows("SELECT * FROM app.audit_logs");
      for (const replica of [false, true]) {
        const refused = t.admin(async (a) => {
          if (replica) await a.query("SET session_replication_role = replica");
          return a.query(sql);
        });
        await expect(refused).rejects.toMatchObject(insertOnly);
      }
      expect(await t.rows("SELECT * FROM app.audit_logs")).toEqual(before);
    },
  );

  // R184: TRUNCATE on the parent and on a leaf; a dropped partition stays possible (retention).
  it.each(["parent", "leaf"])("TRUNCATE of the %s is refused", async (which) => {
    const refused = t.admin((a) => a.query(`TRUNCATE ${which === "parent" ? "app.audit_logs" : leaf}`));
    await expect(refused).rejects.toMatchObject(insertOnly);
  });

  it("the parent and every leaf carry one row trigger and one TRUNCATE trigger, all ENABLE ALWAYS", async () => {
    const found = await t.rows(
      `WITH rels AS (SELECT 'app.audit_logs'::regclass::oid AS oid UNION ALL ${LEAVES})
       SELECT r.oid::regclass::text AS rel,
              count(*) FILTER (WHERE t.tgtype & 1 = 1 AND t.tgtype & 24 = 24)::int AS row_triggers,
              count(*) FILTER (WHERE t.tgtype & 32 = 32)::int AS truncate_triggers,
              count(*) FILTER (WHERE t.tgenabled <> 'A')::int AS not_always
       FROM rels r LEFT JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal GROUP BY r.oid`,
    );
    expect(found.length).toBeGreaterThanOrEqual(4);
    for (const row of found)
      expect(row).toMatchObject({ row_triggers: 1, truncate_triggers: 1, not_always: 0 });
  });
});

describe("ownership and leaf privileges", () => {
  const t = useDatabase();

  // R185, R190
  it("the parent, every leaf and the head table are owned by shoutory_definer", async () => {
    const owners = await t.rows(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
       WHERE c.oid IN ('app.audit_logs'::regclass, 'app.audit_heads'::regclass) OR c.oid IN (${LEAVES})`,
    );
    expect(owners).toEqual([{ owner: "shoutory_definer" }]);
  });

  it("no runtime role and not PUBLIC holds any privilege on a leaf", async () => {
    const held = await t.rows(
      `SELECT c.relname, a.privilege_type, coalesce(r.rolname, 'PUBLIC') AS role
       FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE c.relispartition AND c.relnamespace = 'app'::regnamespace AND (a.grantee = 0 OR r.rolname = ANY ($1))`,
      [RUNTIME_ROLES],
    );
    expect(held).toEqual([]);
  });
});

describe("the hash chain", () => {
  const t = useDatabase();
  const headOf = (workspace: string) =>
    t.rows(`SELECT head_hash FROM app.audit_heads WHERE workspace_id = $1 AND day = ${TODAY}`, [workspace]);

  it("links each row to the previous hash from the genesis and the head holds the last hash", async () => {
    for (let n = 0; n < 3; n++) await writeAudit(t.db().pool("app"), ctxA);
    const rows = await t.rows(CHAIN, [WA]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.prev_hash).toEqual(GENESIS);
    expect(rows[1]?.prev_hash).toEqual(rows[0]?.hash);
    expect(rows[2]?.prev_hash).toEqual(rows[1]?.hash);
    expect(await headOf(WA)).toEqual([{ head_hash: rows[2]?.hash }]);
    expect(await t.rows(HASH_BAD)).toEqual([{ bad: 0 }]);
  });

  it("the hash does not depend on the session's TimeZone or DateStyle", async () => {
    await withTenant(t.db().pool("app"), ctxA, async (tx) => {
      await tx.query("SET LOCAL TimeZone = 'Pacific/Chatham'");
      await tx.query("SET LOCAL DateStyle = 'German, DMY'");
      await tx.query(AUDIT, ["post.created", randomUUID(), null, "{}"]);
    });
    expect(await t.rows(HASH_BAD)).toEqual([{ bad: 0 }]);
  });

  // R186 and R188: the day is the UTC day of `at`; yesterday's head never feeds today's first row.
  it("a day with no head starts at the genesis whatever yesterday's head holds, and day is the UTC day of at", async () => {
    await t.rows(
      `INSERT INTO app.audit_heads (workspace_id, day, head_hash)
       VALUES ($1, ${TODAY} - 1, decode(repeat('ab', 32), 'hex'))`,
      [WB],
    );
    await writeAudit(t.db().pool("app"), ctxOf(WB, OB));
    const first = await t.rows(CHAIN, [WB]);
    expect(first.map((row) => row.prev_hash)).toEqual([GENESIS]);
    const orphans = await t.rows(
      `SELECT count(*)::int AS n FROM app.audit_logs l WHERE NOT EXISTS (
         SELECT 1 FROM app.audit_heads h WHERE h.workspace_id IS NOT DISTINCT FROM l.workspace_id
           AND h.day = (l.at AT TIME ZONE 'UTC')::date)`,
    );
    expect(orphans).toEqual([{ n: 0 }]);
  });
});

describe("concurrent writers", () => {
  const t = useDatabase();
  const insert = (action: string) => (client: PoolClient) =>
    client.query(AUDIT, [action, randomUUID(), null, "{}"]);
  const app = () => t.db().pool("app");

  // R186: forced, not hoped for. tx1 holds the head, tx2 is seen waiting in pg_locks, then tx1 commits.
  it("a second writer waits for the head lock and then chains after the first", async () => {
    await writeAudit(app(), ctxA);
    const first = await openTx(app(), ctxA);
    const second = await openTx(app(), ctxA);
    const outcome = await holdThenRace(t.rows, first, second, (client, n) =>
      insert(n === 1 ? "post.created" : "post.updated")(client),
    );
    expect(outcome.secondError).toBeUndefined();
    const rows = await t.rows(CHAIN, [WA]);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.prev_hash).toEqual(rows[0]?.hash);
    expect(rows[2]?.prev_hash).toEqual(rows[1]?.hash);
    const actions = await t.rows(
      "SELECT action FROM app.audit_logs WHERE workspace_id = $1 ORDER BY at, id",
      [WA],
    );
    expect(actions.map((row) => row.action)).toEqual(["post.created", "post.created", "post.updated"]);
  });

  // The first row of a chain has no head to lock yet: tx1 creates it uncommitted, tx2 must wait on it and then both
  // rows must form one chain (a check-then-insert head would fail here with a unique violation or two genesis rows).
  it("two first writers of a new workspace chain both succeed and link", async () => {
    const fresh = randomUUID();
    await t.rows(
      `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, '${OA}', 'ws-n', 'ws-n')`,
      [fresh],
    );
    const first = await openTx(app(), ctxOf(fresh));
    const second = await openTx(app(), ctxOf(fresh));
    expect((await holdThenRace(t.rows, first, second, insert("post.created"))).secondError).toBeUndefined();
    const rows = await t.rows(CHAIN, [fresh]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prev_hash).toEqual(GENESIS);
    expect(rows[1]?.prev_hash).toEqual(rows[0]?.hash);
  });
});

describe("the instance chain and rows with no workspace", () => {
  const t = useDatabase();

  it("two first sign-in rows both succeed and link, from the genesis", async () => {
    const first = await openTx(t.db().pool("auth"), null);
    const second = await openTx(t.db().pool("auth"), null);
    const outcome = await holdThenRace(t.rows, first, second, (client) =>
      client.query("SELECT app.audit_insert_instance('auth.sign_in', 'user', $1, 'req-2', NULL, '{}')", [UA]),
    );
    expect(outcome.secondError).toBeUndefined();
    const rows = await t.rows(CHAIN, [null]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prev_hash).toEqual(GENESIS);
    expect(rows[1]?.prev_hash).toEqual(rows[0]?.hash);
  });

  // R187: an organization-only row has no read policy at M0.
  it("an organization-only row and an instance row are invisible to the app role, whatever the context", async () => {
    await t.rows(
      `INSERT INTO app.audit_logs (id, at, workspace_id, organization_id, actor_kind, actor_ref, action,
         resource_kind, resource_id, request_id, ip_hmac, metadata, prev_hash, hash)
       VALUES (gen_random_uuid(), now(), NULL, '${OA}', 'user', '${UA}', 'org.updated', 'organization', '${OA}',
         'req-3', NULL, '{}', decode(repeat('00', 32), 'hex'), decode(repeat('01', 32), 'hex'))`,
    );
    for (const ctx of [ctxA, { organizationId: OA, principalKind: "user", principalId: UA } as const]) {
      const seen = await withTenant(t.db().pool("app"), ctx, (tx) =>
        tx.query("SELECT count(*)::int AS n FROM app.audit_logs WHERE workspace_id IS NULL"),
      );
      expect(seen.rows).toEqual([{ n: 0 }]);
    }
  });
});

// V-48: a unique index on a partitioned table must contain the partition key, on the parent and on every leaf.
const KEYLESS = `
  SELECT i.indexrelid::regclass::text AS idx FROM pg_index i
  WHERE (i.indisprimary OR i.indisunique) AND i.indrelid IN (SELECT 'app.audit_logs'::regclass::oid UNION ALL ${LEAVES})
    AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey) AS k (attnum)
                    WHERE k.attnum = (SELECT attnum FROM pg_attribute
                                      WHERE attrelid = 'app.audit_logs'::regclass AND attname = 'at'))`;

describe("V-48: unique keys of the partitioned audit table include the partition key", () => {
  const t = useDatabase();

  it("no primary key or unique index of the table or a leaf lacks `at`", async () => {
    expect(await t.rows(KEYLESS)).toEqual([]);
  });

  it("a leaf-local unique index without `at` is reported", async () => {
    const leaf = (await t.rows(`SELECT inhrelid::regclass::text AS name FROM (${LEAVES}) l LIMIT 1`))[0]
      ?.name;
    await t.rows(`CREATE UNIQUE INDEX audit_planted_idx ON ${leaf} (id)`);
    expect(await t.rows(KEYLESS)).toEqual([{ idx: "app.audit_planted_idx" }]);
  });
});
