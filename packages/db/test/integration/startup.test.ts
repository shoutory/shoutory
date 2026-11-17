import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadMigrations } from "../../src/migrate/runner.js";
import { assertMigrationsApplied, MissingMigrationError } from "../../src/migrate/startup.js";
import { cloneTemplate, emptyDatabase, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

describe("start-up migration check", () => {
  let migrated: TestDatabase;
  let blank: TestDatabase;
  let dir: string;
  let pending: string;

  beforeAll(async () => {
    migrated = await cloneTemplate(env, inject("shoutoryTemplate"));
    blank = await emptyDatabase(env);
    dir = await mkdtemp(join(tmpdir(), "startup-"));
    const shipped = await loadMigrations();
    for (const { name } of shipped) await writeFile(join(dir, name), "SELECT 1;");
    // The next free number, so a new shipped migration never collides with the planted one.
    pending = `${String(shipped.length + 1).padStart(4, "0")}_not_applied_yet.sql`;
    await writeFile(join(dir, pending), "SELECT 1;");
  });
  afterAll(async () => {
    await migrated.drop();
    await blank.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("passes for the app role when every shipped migration is applied", async () => {
    await expect(assertMigrationsApplied(migrated.pool("app"))).resolves.toBeUndefined();
  });

  it("refuses to start when a required migration is missing", async () => {
    const check = assertMigrationsApplied(migrated.pool("app"), dir);
    await expect(check).rejects.toThrow(MissingMigrationError);
    await expect(check).rejects.toThrow(pending);
  });

  it("refuses to start on a migration folder with a gap, by the runner's named error", async () => {
    const gapped = await mkdtemp(join(tmpdir(), "startup-gap-"));
    try {
      await writeFile(join(gapped, "0001_first.sql"), "SELECT 1;");
      await writeFile(join(gapped, "0003_third.sql"), "SELECT 1;");
      await expect(assertMigrationsApplied(migrated.pool("app"), gapped)).rejects.toMatchObject({
        name: "MigrationFolderError",
      });
    } finally {
      await rm(gapped, { recursive: true, force: true });
    }
  });

  it("refuses to start on a database that was never migrated", async () => {
    await expect(assertMigrationsApplied(blank.pool("owner"))).rejects.toThrow(MissingMigrationError);
  });
});
