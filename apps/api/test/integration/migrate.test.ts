import { loadMigrations } from "@shoutory/db/migrate";
import { emptyDatabase, readTestEnv, withAdminClient } from "@shoutory/db/testing";
import { describe, expect, it } from "vitest";
import { migrateCommand } from "../../src/cli/migrate.js";

const env = readTestEnv();

// Each of the first two tests applies every shipped migration to an empty database, so its time grows with each new migration.
describe("shoutory migrate", { timeout: 30_000 }, () => {
  it("applies the shipped migrations as the owner role and reports them, then reports nothing pending", async () => {
    const db = await emptyDatabase(env);
    try {
      const lines: string[] = [];
      const settings = { SHOUTORY_DATABASE_URL_OWNER: db.url("owner") };
      await migrateCommand(settings, (line) => lines.push(line));
      await migrateCommand(settings, (line) => lines.push(line));
      const names = (await loadMigrations()).map(({ name }) => name);
      expect(lines).toEqual([...names.map((name) => `applied ${name}`), "no pending migrations"]);
    } finally {
      await db.drop();
    }
  });

  it("run twice succeeds and leaves the same grants in the job queue's schema", async () => {
    const db = await emptyDatabase(env);
    try {
      const settings = { SHOUTORY_DATABASE_URL_OWNER: db.url("owner") };
      const grants = () =>
        withAdminClient(
          env,
          db.name,
          async (a) =>
            (
              await a.query(
                `SELECT 'table' AS kind, grantee::text AS who, table_name::text AS object, privilege_type AS what
                   FROM information_schema.table_privileges WHERE table_schema = 'pgboss' AND grantee LIKE 'shoutory_%'
                 UNION ALL SELECT 'routine', grantee::text, routine_name::text, privilege_type
                   FROM information_schema.routine_privileges WHERE routine_schema = 'pgboss' AND grantee LIKE 'shoutory_%'
                 UNION ALL SELECT 'schema', nspacl::text, nspname::text, '' FROM pg_namespace WHERE nspname = 'pgboss'
                 UNION ALL SELECT 'default', defaclacl::text, defaclobjtype::text, ''
                   FROM pg_default_acl WHERE defaclnamespace = 'pgboss'::regnamespace
                 ORDER BY 1, 2, 3, 4`,
              )
            ).rows,
        );
      await migrateCommand(settings, () => undefined);
      const first = await grants();
      await migrateCommand(settings, () => undefined);
      expect(first.length).toBeGreaterThan(0);
      expect(await grants()).toEqual(first);
    } finally {
      await db.drop();
    }
  });

  it("names the missing setting instead of connecting somewhere else", async () => {
    await expect(migrateCommand({}, () => undefined)).rejects.toThrow("SHOUTORY_DATABASE_URL_OWNER");
  });
});
