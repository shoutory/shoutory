import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

// A table or column whose uuid key is given by the caller, never made by the database; each has its reason.
const CALLER_SUPPLIED: Record<string, string> = {
  email_outbox: "the sealed link is bound to the row id, so the caller makes the id before it seals",
};

async function keyColumns(pool: Pool) {
  const found = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name, pg_get_expr(d.adbin, d.adrelid) AS expression
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey)
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE k.contype = 'p' AND c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition AND a.atttypid = 'uuid'::regtype AND a.attname = 'id'
      ORDER BY c.relname`,
  );
  return found.rows as { table_name: string; column_name: string; expression: string | null }[];
}

describe("primary keys", () => {
  it("every uuid primary-key id in app has a uuidv7() default; walked tables at least the catalog count at write time, explicit allowlist for caller-supplied keys", async () => {
    const columns = await keyColumns(db.pool("owner"));
    expect(columns.length).toBeGreaterThanOrEqual(28);
    const wrong = columns
      .filter((column) => !(column.expression ?? "").includes("uuidv7()"))
      .filter((column) => CALLER_SUPPLIED[column.table_name] === undefined)
      .map((column) => `${column.table_name}.${column.column_name}: ${column.expression ?? "no default"}`);
    expect(wrong).toEqual([]);
    for (const [table, reason] of Object.entries(CALLER_SUPPLIED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(columns.some((column) => column.table_name === table)).toBe(true);
    }
  });
});
