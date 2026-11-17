import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor: a table under the W template must show a session only its read set, let it write only its one
// write workspace, and fail closed for every other principal. Settings are planted raw on purpose: the invariant
// scanner exempts test files, and a raw value is the only way to try a context withTenant would refuse.
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();

type Settings = Record<string, string>;
const ctx = (read: string[], write: string, kind = "user"): Settings => ({
  "app.workspace_ids": `{${read.join(",")}}`,
  "app.write_workspace_id": write,
  "app.principal_kind": kind,
});

async function inTransaction<T>(
  pool: Pool,
  settings: Settings,
  run: (query: (sql: string) => Promise<QueryResult>) => Promise<T>,
  commit = false,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [name, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    const result = await run((sql) => client.query(sql));
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Expected = { rows: number } | { count: number } | { refused: true };

const own = (workspace: string) => `SELECT label FROM app.fx WHERE workspace_id = '${workspace}'`;
const insert = (workspace: string) =>
  `INSERT INTO app.fx (workspace_id, label) VALUES ('${workspace}', 'new')`;
const update = (where: string) => `UPDATE app.fx SET label = 'x' WHERE ${where}`;
const all = "SELECT * FROM app.fx";
const wipe = "DELETE FROM app.fx";

// Rows: title, settings (undefined = no context at all), statement, what the caller must see.
const ROWS: [string, Settings | undefined, string, Expected][] = [
  ["a user reads its own workspaces (positive control)", ctx([A, B], A), all, { rows: 2 }],
  ["a job reads its own workspace (positive control)", ctx([A], A, "job"), own(A), { rows: 1 }],
  ["cross-workspace SELECT returns 0 rows", ctx([A], A), own(B), { rows: 0 }],
  ["INSERT into another workspace is refused", ctx([A, B], A), insert(B), { refused: true }],
  ["INSERT into the write workspace is accepted", ctx([A, B], A), insert(A), { count: 1 }],
  [
    "UPDATE of a readable row outside the write set touches 0 rows",
    ctx([A, B], A),
    update(`workspace_id = '${B}'`),
    { count: 0 },
  ],
  [
    "DELETE of a readable row outside the write set touches 0 rows",
    ctx([A, B], A),
    `${wipe} WHERE workspace_id = '${B}'`,
    { count: 0 },
  ],
  ["an empty write set refuses INSERT", ctx([A, B], ""), insert(A), { refused: true }],
  ["an empty write set makes UPDATE touch 0 rows", ctx([A, B], ""), update("true"), { count: 0 }],
  ["an empty write set makes DELETE touch 0 rows", ctx([A, B], ""), wipe, { count: 0 }],
  ["a missing context reads 0 rows", undefined, all, { rows: 0 }],
  ["an empty context reads 0 rows", ctx([], ""), all, { rows: 0 }],
  [
    "UPDATE moving a row to another workspace is refused",
    ctx([A, B], A),
    `UPDATE app.fx SET workspace_id = '${B}' WHERE workspace_id = '${A}'`,
    { refused: true },
  ],
  ["a portal principal reads 0 rows", ctx([A], A, "portal"), all, { rows: 0 }],
  [
    "a portal principal with a write workspace is refused INSERT",
    ctx([A], A, "portal"),
    insert(A),
    { refused: true },
  ],
  [
    "a portal principal with a write workspace updates 0 rows",
    ctx([A], A, "portal"),
    update("true"),
    { count: 0 },
  ],
  ["a portal principal with a write workspace deletes 0 rows", ctx([A], A, "portal"), wipe, { count: 0 }],
  ["an unset principal kind reads 0 rows", ctx([A], A, ""), all, { rows: 0 }],
  ["an unknown principal kind ('Portal ') reads 0 rows", ctx([A], A, "Portal "), all, { rows: 0 }],
  [
    "a write workspace outside the read set refuses a row for a third workspace",
    ctx([A], B),
    insert(C),
    { refused: true },
  ],
  [
    "a write workspace outside the read set refuses a plain INSERT into it",
    ctx([A], B),
    insert(B),
    { refused: true },
  ],
  ["a write workspace outside the read set updates 0 rows", ctx([A], B), update("true"), { count: 0 }],
  ["a write workspace outside the read set deletes 0 rows", ctx([A], B), wipe, { count: 0 }],
  [
    "INSERT RETURNING with the write workspace inside the read set returns the row",
    ctx([A, B], A),
    `${insert(A)} RETURNING label`,
    { rows: 1 },
  ],
  [
    "INSERT RETURNING with the write workspace outside the read set is refused",
    ctx([A], B),
    `${insert(B)} RETURNING label`,
    { refused: true },
  ],
];

describe("fixture table under apply_rls_template is isolated", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    const owner = db.pool("owner");
    await owner.query(
      "CREATE TABLE app.fx (id uuid PRIMARY KEY DEFAULT uuidv7(), workspace_id uuid NOT NULL, label text NOT NULL)",
    );
    await owner.query("GRANT SELECT, INSERT, UPDATE, DELETE ON app.fx TO shoutory_app, shoutory_worker");
    await owner.query("SELECT app.apply_rls_template('app.fx'::regclass, 'W')");
    for (const workspace of [A, B]) {
      const seed = `INSERT INTO app.fx (workspace_id, label) VALUES ('${workspace}', 'seed')`;
      await inTransaction(db.pool("app"), ctx([workspace], workspace), (query) => query(seed), true);
    }
  });
  afterAll(() => db.drop());

  it.each(ROWS)("%s", async (_title, settings, sql, expected) => {
    const run = inTransaction(db.pool("app"), settings ?? {}, (query) => query(sql));
    if ("refused" in expected) {
      await expect(run).rejects.toMatchObject({ code: "42501" });
      return;
    }
    const result = await run;
    if ("rows" in expected) expect(result.rows).toHaveLength(expected.rows);
    else expect(result.rowCount).toBe(expected.count);
  });

  it("the worker role is held to the same policies", async () => {
    const result = await inTransaction(db.pool("worker"), ctx([A], A), (query) => query(own(B)));
    expect(result.rows).toHaveLength(0);
  });

  it("the table owner reads 0 of the seeded rows (FORCE)", async () => {
    const seen = await db.pool("owner").query("SELECT count(*)::int AS n FROM app.fx");
    expect(seen.rows[0].n).toBe(0);
  });
});

describe("apply_rls_template refuses hostile input", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it("an unknown template raises", async () => {
    const owner = db.pool("owner");
    await owner.query("CREATE TABLE app.fx_unknown (workspace_id uuid NOT NULL)");
    const apply = owner.query("SELECT app.apply_rls_template('app.fx_unknown'::regclass, 'nope')");
    await expect(apply).rejects.toThrow(/unknown template/i);
  });

  it("a key column whose name holds a quote and a space is quoted, not interpreted", async () => {
    const owner = db.pool("owner");
    await owner.query(`CREATE TABLE app.fx_odd ("we""ird col" uuid NOT NULL, label text NOT NULL)`);
    await owner.query("GRANT SELECT, INSERT ON app.fx_odd TO shoutory_app");
    await owner.query(`SELECT app.apply_rls_template('app.fx_odd'::regclass, 'W', 'we"ird col')`);
    const read = await inTransaction(db.pool("app"), ctx([A], A), async (query) => {
      await query(`INSERT INTO app.fx_odd ("we""ird col", label) VALUES ('${A}', 'odd')`);
      return query("SELECT label FROM app.fx_odd");
    });
    expect(read.rows).toEqual([{ label: "odd" }]);
  });

  it("a key column holding an injection string raises with no side effect", async () => {
    const owner = db.pool("owner");
    await owner.query("CREATE TABLE app.fx_inject (workspace_id uuid NOT NULL)");
    const hostile = "workspace_id) OR true; CREATE TABLE app.pwned (x int); --";
    const apply = owner.query("SELECT app.apply_rls_template('app.fx_inject'::regclass, 'W', $1)", [hostile]);
    // The whole string is one identifier that names no column, not SQL.
    await expect(apply).rejects.toMatchObject({ code: "42703" });
    const found = await owner.query("SELECT to_regclass('app.pwned') AS pwned");
    expect(found.rows[0].pwned).toBeNull();
  });
});
