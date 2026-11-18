import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// Two earlier tables hold a workspace id as a plain uuid until the workspaces table exists. Those keys are added
// without a scan and validated in the same migration. Every key of the tenancy tables states what it does when its
// parent row is deleted: a membership follows its organization or workspace, and a user or a role is never removed
// from under a membership.
let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

const FOREIGN_KEY = `
  SELECT k.convalidated, k.confdeltype, k.confrelid::regclass::text AS parent
  FROM pg_constraint k
  WHERE k.contype = 'f' AND k.conrelid = $1::regclass
    AND k.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = k.conrelid AND attname = $2)]`;

describe("foreign keys of the tenancy tables exist, are validated and state their delete action", () => {
  it.each([
    ["app.user_profiles", "last_workspace_id", "app.workspaces", "n"],
    ["app.email_outbox", "workspace_id", "app.workspaces", "a"],
    ["app.workspace_members", "workspace_id", "app.workspaces", "c"],
    ["app.organization_members", "organization_id", "app.organizations", "c"],
    ["app.workspace_members", "user_id", 'auth."user"', "a"],
    ["app.organization_members", "user_id", 'auth."user"', "a"],
    ["app.workspace_members", "role_id", "app.roles", "a"],
    ["app.invitations", "workspace_id", "app.workspaces", "c"],
    ["app.invitations", "role_id", "app.roles", "a"],
    ["app.invitations", "invited_by", 'auth."user"', "a"],
    ["app.invitations", "accepted_by", 'auth."user"', "a"],
  ])("%s.%s references %s, is validated, with delete action %s", async (table, column, parent, action) => {
    const found = await db.pool("owner").query(FOREIGN_KEY, [table, column]);
    expect(found.rows).toEqual([{ convalidated: true, confdeltype: action, parent }]);
  });
});
