import { loadMigrations } from "@shoutory/db/migrate";
import { emptyDatabase, readTestEnv } from "@shoutory/db/testing";
import { describe, expect, it } from "vitest";
import { migrateCommand } from "../../src/cli/migrate.js";

const env = readTestEnv();

describe("shoutory migrate", () => {
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

  it("names the missing setting instead of connecting somewhere else", async () => {
    await expect(migrateCommand({}, () => undefined)).rejects.toThrow("SHOUTORY_DATABASE_URL_OWNER");
  });
});
