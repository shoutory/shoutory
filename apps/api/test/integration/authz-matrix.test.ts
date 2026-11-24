import { ROLE_PERMISSIONS, WORKSPACE_ROLES } from "@shoutory/core/authz";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

describe("matrix.ts and the seeded built-in roles hold the same permissions", () => {
  it.each(WORKSPACE_ROLES)("the built-in role %s has exactly the matrix permissions", async (key) => {
    const seeded = await withAdminClient(env, db.name, (admin) =>
      admin.query("SELECT permissions FROM app.roles WHERE workspace_id IS NULL AND key = $1", [key]),
    );
    expect(seeded.rows).toHaveLength(1);
    expect([...seeded.rows[0].permissions].sort()).toEqual([...ROLE_PERMISSIONS[key]].sort());
  });
});
