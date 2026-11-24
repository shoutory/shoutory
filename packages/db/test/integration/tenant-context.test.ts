import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withTenant } from "../../src/context/with-tenant.js";
import { cloneTemplate, readTestEnv, type TestDatabase, withDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

const A = randomUUID();
const B = randomUUID();
const PURPOSE = `o'brien "x"; --`;
const FULL = {
  workspaceIds: [A, B],
  writeWorkspaceId: A,
  principalKind: "job",
  jobPurpose: PURPOSE,
} as const;

type Ctx = Parameters<typeof withTenant>[1];

// A single-connection pool: a second request must reuse the first one's connection.
function useSingleConnectionPool(): () => Pool {
  let db: TestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    pool = new Pool({ connectionString: db.url("app"), max: 1 });
    pool.on("error", () => undefined);
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });
  return () => pool;
}

const nextRequestSees = async (pool: Pool) => {
  const seen = await pool.query(
    "SELECT app.ws_ids()::text[] AS ids, app.write_ws() AS write, app.job_purpose() AS purpose, app.principal_kind() AS kind",
  );
  return seen.rows[0];
};
const EMPTY = { ids: [], write: null, purpose: null, kind: null };

describe("withTenant context lifetime", () => {
  const getPool = useSingleConnectionPool();

  it.each(["commit", "rollback"])("settings are transaction-local after a %s", async (ending) => {
    const pool = getPool();
    const inside = withTenant(pool, FULL, async (tx) => {
      const seen = await tx.query(
        "SELECT app.ws_ids()::text[] AS ids, app.write_ws() AS write, current_setting('app.job_purpose') AS purpose",
      );
      if (ending === "rollback") throw new Error("request failed");
      return seen.rows[0];
    });
    if (ending === "rollback") await expect(inside).rejects.toThrow("request failed");
    else expect(await inside).toEqual({ ids: [A, B], write: A, purpose: PURPOSE });
    expect(await nextRequestSees(pool)).toEqual(EMPTY);
  });

  it("destroys the connection when the rollback itself fails", async () => {
    const pool = getPool();
    const failing = withTenant(pool, FULL, async (tx) => {
      await tx.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
      throw new Error("request failed");
    });
    await expect(failing).rejects.toThrow("request failed");
    expect(pool.totalCount).toBe(0);
    expect(await nextRequestSees(pool)).toEqual(EMPTY);
  });
});

describe("withTenant input", () => {
  const getPool = useSingleConnectionPool();

  it("an absent field is sent as an empty string, never as NULL", async () => {
    // A role default for this database: set_config(name, NULL, true) resets to it, set_config(name, '', true)
    // overrides it. Only a connection opened after the ALTER sees the default.
    const url = getPool().options.connectionString ?? "";
    const database = new URL(url).pathname.slice(1);
    const admin = new Client({ connectionString: withDatabase(env.adminUrl, database) });
    await admin.connect();
    await admin.query(`ALTER ROLE shoutory_app IN DATABASE "${database}" SET app.principal_kind = 'portal'`);
    const fresh = new Pool({ connectionString: url, max: 1 });
    try {
      const seen = await withTenant(fresh, {}, (tx) =>
        tx.query("SELECT current_setting('app.principal_kind', true) AS kind"),
      );
      expect(seen.rows[0]).toEqual({ kind: "" });
    } finally {
      await fresh.end();
      await admin.end();
    }
  });

  it("writes workspace ids lower-cased, de-duplicated, as an array literal", async () => {
    const seen = await withTenant(getPool(), { workspaceIds: [A.toUpperCase(), A, B] }, (tx) =>
      tx.query("SELECT current_setting('app.workspace_ids') AS ids"),
    );
    expect(seen.rows[0]?.ids).toBe(`{${A},${B}}`);
  });

  it.each([
    ["a workspace id that is not a uuid", { workspaceIds: ["not-a-uuid"] }],
    ["more than 500 workspace ids", { workspaceIds: Array.from({ length: 501 }, () => randomUUID()) }],
    ["an unknown principal kind", { principalKind: "admin" }],
    ["an unknown service kind", { serviceKind: "key" }],
    ["an empty job purpose", { jobPurpose: "" }],
    ["a job purpose over 64 characters", { jobPurpose: "x".repeat(65) }],
  ])("refuses %s before it opens a transaction", async (_title, ctx) => {
    let ran = false;
    const refused = withTenant(getPool(), ctx as Ctx, async () => {
      ran = true;
    });
    await expect(refused).rejects.toThrow();
    expect(ran).toBe(false);
    expect(getPool().totalCount - getPool().idleCount).toBe(0);
  });
});
