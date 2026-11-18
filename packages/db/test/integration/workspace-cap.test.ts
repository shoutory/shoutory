import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// workspace_create refuses the 101st workspace of an organization (R228, R240). Archived rows count too (R251).
const FULL = randomUUID();
const ALMOST = randomUUID();
const OWNER = randomUUID();
const OTHER = randomUUID();
let db: TestDatabase;
const rows = (sql: string, params?: unknown[]) =>
  withAdminClient(env, db.name, async (a) => (await a.query(sql, params)).rows);
const CREATE = "SELECT app.workspace_create($1::uuid, 'cap', $2, 'UTC', NULL, NULL)";
const slug = () => `cap-${randomUUID().slice(0, 8)}`;

// One statement seeds the workspaces and their Owners, so the commit-time Owner guard is satisfied.
async function seedOrganization(organization: string, count: number): Promise<void> {
  await rows(
    `WITH w AS (INSERT INTO app.workspaces (organization_id, name, slug)
       SELECT $1, 'cap', 'seed-' || g FROM generate_series(1, $2::int) AS g RETURNING id)
     INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       SELECT w.id, $3, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'owner') FROM w`,
    [organization, count, OWNER],
  );
}

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await rows(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES
       ('${OWNER}', 'cap-owner', 'cap-owner@example.test', true), ('${OTHER}', 'cap-other', 'cap-other@example.test', true);
     INSERT INTO app.organizations (id, name, slug, type) VALUES
       ('${FULL}', 'cap-full', 'cap-full', 'team'), ('${ALMOST}', 'cap-almost', 'cap-almost', 'team');
     INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES
       ('${FULL}', '${OWNER}', 'owner'), ('${ALMOST}', '${OWNER}', 'owner'), ('${ALMOST}', '${OTHER}', 'admin')`,
  );
  await seedOrganization(FULL, 100);
  await seedOrganization(ALMOST, 99);
  await rows("UPDATE app.workspaces SET archived_at = now() WHERE organization_id = $1 AND slug = 'seed-1'", [
    FULL,
  ]);
});
afterAll(() => db.drop());

describe("the workspace cap of an organization", () => {
  it("refuses the 101st workspace with 53400 and the workspace_create prefix, archived rows counted", async () => {
    const result = await attempt(db.pool("app"), asUser(OWNER), CREATE, [FULL, slug()]);
    expect(result.error).toMatchObject({
      code: "53400",
      message: "workspace_create: at most 100 workspaces per organization",
    });
  });

  it("two callers at 99 admit one: the second is refused and the organization ends at 100", async () => {
    const outcome = await holdThenRace(
      rows,
      await openTx(db.pool("app"), asUser(OWNER)),
      await openTx(db.pool("app"), asUser(OTHER)),
      (client) => client.query(CREATE, [ALMOST, slug()]),
    );
    expect(outcome.secondError).toMatchObject({ code: "53400" });
    expect(
      await rows("SELECT count(*)::int AS n FROM app.workspaces WHERE organization_id = $1", [ALMOST]),
    ).toEqual([{ n: 100 }]);
  });
});
