import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Exempt by name: a reference to the workspace or the organization itself, the member's role, whose built-in rows
// have no workspace, and the workspace's avatar (its key is the workspace's own id).
interface ForeignKey {
  name: string;
  child: string;
  childColumns: string[];
  parent: string;
  parentColumns: string[];
}

async function tenantForeignKeys(pool: Pool): Promise<{ walked: string[]; keys: ForeignKey[] }> {
  const tables = await pool.query(
    `SELECT DISTINCT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'app'::regnamespace AND NOT c.relispartition AND p.polname IN ('w_select', 'o_select')`,
  );
  const walked = tables.rows.map((row) => row.relname as string).sort();
  const found = await pool.query(
    `SELECT k.conname AS name, child.relname AS child, parent.relname AS parent,
       ARRAY(SELECT attname::text FROM unnest(k.conkey) WITH ORDINALITY u (attnum, ord)
             JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord) AS child_columns,
       ARRAY(SELECT attname::text FROM unnest(k.confkey) WITH ORDINALITY u (attnum, ord)
             JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord) AS parent_columns
     FROM pg_constraint k JOIN pg_class child ON child.oid = k.conrelid JOIN pg_class parent ON parent.oid = k.confrelid
     WHERE k.contype = 'f' AND child.relnamespace = 'app'::regnamespace AND parent.relnamespace = 'app'::regnamespace
       AND child.relname = ANY ($1) AND parent.relname = ANY ($1)`,
    [walked],
  );
  const keys = found.rows.map((row) => ({
    name: row.name,
    child: row.child,
    childColumns: row.child_columns,
    parent: row.parent,
    parentColumns: row.parent_columns,
  }));
  return { walked, keys };
}

function violations(keys: ForeignKey[]): string[] {
  return keys
    .filter((key) => {
      const composite =
        key.childColumns.includes("workspace_id") && key.parentColumns.includes("workspace_id");
      const toTenantRoot =
        ["workspaces", "organizations"].includes(key.parent) && key.parentColumns.join() === "id";
      const memberRole =
        ["workspace_members", "invitations"].includes(key.child) && key.childColumns.join() === "role_id";
      // The workspace's avatar is an asset of the workspace itself: the key is (id, avatar) -> (workspace_id, id).
      const avatar = key.child === "workspaces" && key.childColumns.join() === "id,avatar";
      return !(composite || toTenantRoot || memberRole || avatar);
    })
    .map((key) => `${key.child}(${key.childColumns}) -> ${key.parent}(${key.parentColumns})`);
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

describe("pg_constraint walk: every FK between tenant tables is composite with workspace_id", () => {
  const clone = useClone();

  it("the migrated tenant tables hold no single-column foreign key", async () => {
    const { walked, keys } = await tenantForeignKeys(clone().pool("owner"));
    expect(walked.length).toBeGreaterThanOrEqual(5);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(violations(keys)).toEqual([]);
  });
});

describe("pg_constraint walk: a planted single-column foreign key is reported", () => {
  const clone = useClone(async (admin) => {
    await admin.query("CREATE TABLE app.fx_parent (workspace_id uuid NOT NULL, id uuid PRIMARY KEY)");
    await admin.query(
      "CREATE TABLE app.fx_child (workspace_id uuid NOT NULL, parent_id uuid NOT NULL REFERENCES app.fx_parent (id))",
    );
    await admin.query("SELECT app.apply_rls_template('app.fx_parent'::regclass, 'W')");
    await admin.query("SELECT app.apply_rls_template('app.fx_child'::regclass, 'W')");
  });

  it("the child that skips workspace_id is a violation", async () => {
    const { keys } = await tenantForeignKeys(clone().pool("owner"));
    expect(violations(keys)).toContain("fx_child(parent_id) -> fx_parent(id)");
  });
});
