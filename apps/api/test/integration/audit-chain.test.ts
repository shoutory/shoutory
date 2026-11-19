import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { run } from "../../src/cli/main.js";

const env = readTestEnv();

// `shoutory audit verify [day]` asks the database to recompute the hash chain of one UTC day (the chain itself is
// tested in packages/db) and turns the answer into an exit code an operator's script can use.
let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

const today = () => new Date().toISOString().slice(0, 10);
const verify = async (...args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    ["audit", "verify", ...args],
    { SHOUTORY_DATABASE_URL_OWNER: db.url("owner") },
    {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  );
  return { code, out, err };
};

describe("shoutory audit verify", () => {
  it("exits 0 for an empty day and for a day whose chain holds", async () => {
    expect(await verify()).toMatchObject({ code: 0, out: [`audit chain verified for ${today()}`] });
    for (const n of [1, 2]) {
      await db
        .pool("auth")
        .query("SELECT app.audit_insert_instance('auth.sign_in', 'user', $1, 'req-1', NULL, '{}')", [
          `cli-${n}`,
        ]);
    }
    expect(await verify(today())).toMatchObject({ code: 0, out: [`audit chain verified for ${today()}`] });
  });

  it("exits 1 and names the row when a row of the day was edited", async () => {
    const written = await withAdminClient(env, db.name, async (a) => {
      const rows = (
        await a.query("SELECT id, tableoid::regclass::text AS leaf FROM app.audit_logs ORDER BY at, id")
      ).rows as { id: string; leaf: string }[];
      await a.query(`ALTER TABLE ${rows[0]?.leaf} DISABLE TRIGGER audit_logs_immutable`);
      await a.query(`UPDATE app.audit_logs SET metadata = '{"edited":1}' WHERE id = $1`, [rows[0]?.id]);
      await a.query(`ALTER TABLE ${rows[0]?.leaf} ENABLE ALWAYS TRIGGER audit_logs_immutable`);
      return rows[0]?.id;
    });
    const result = await verify();
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([`audit chain broken on ${today()} at row ${written} (instance chain)`]);
  });

  it.each([[["2026-13-40"]], [["yesterday"]], [["2026-11-19", "extra"]]])(
    "a bad day argument %j is a usage error",
    async (args) => {
      expect(await verify(...args)).toMatchObject({ code: 2, out: [] });
    },
  );
});
