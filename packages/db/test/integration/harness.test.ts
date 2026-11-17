import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  createTemplate,
  dropDatabase,
  readTestEnv,
  type TestDatabase,
} from "../../src/testing/template.js";

const env = readTestEnv();

describe("test database harness", () => {
  let first: TestDatabase;
  let second: TestDatabase;

  beforeAll(async () => {
    first = await cloneTemplate(env, inject("shoutoryTemplate"));
    second = await cloneTemplate(env, inject("shoutoryTemplate"));
  });

  afterAll(async () => {
    await first.drop();
    await second.drop();
  });

  it("gives every clone its own database", async () => {
    const asApp = await first.pool("app").query("SELECT current_database() AS db");
    expect(asApp.rows[0]).toEqual({ db: first.name });
    expect(first.name).not.toEqual(second.name);
    expect(first.name).not.toEqual(inject("shoutoryTemplate"));
  });

  it("drops a clone so a later run starts clean", async () => {
    const extra = await cloneTemplate(env, inject("shoutoryTemplate"));
    await extra.drop();
    const found = await first
      .pool("owner")
      .query("SELECT 1 FROM pg_database WHERE datname = $1", [extra.name]);
    expect(found.rowCount).toBe(0);
  });

  it("fails the run when the database is unreachable instead of skipping", async () => {
    const unreachable = { ...env, adminUrl: "postgres://postgres:unused@127.0.0.1:1/postgres" };
    await expect(createTemplate(unreachable)).rejects.toThrow();
    await expect(dropDatabase(unreachable, "shoutory_test_none")).rejects.toThrow();
  });

  it.each([["SHOUTORY_TEST_ADMIN_URL"], ["SHOUTORY_DATABASE_URL_APP"]])(
    "refuses to run without %s",
    (name) => {
      const missing = { ...process.env, [name]: undefined };
      expect(() => readTestEnv(missing)).toThrow(name);
    },
  );
});
