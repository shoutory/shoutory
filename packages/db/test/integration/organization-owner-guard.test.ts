import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor: an organization never ends up with no owner. The check is a deferred constraint trigger, so a
// transaction may swap owners, and the refusal comes at commit. Rows are seeded through the administrator URL:
// the migration owner sees no row of a FORCE table without a policy.
const U1 = randomUUID();
const U2 = randomUUID();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await withAdminClient(env, db.name, (admin) =>
    admin.query(
      `INSERT INTO auth."user" (id, name, email) VALUES
         ('${U1}', 'owner-guard-1', 'owner-guard-1@example.test'), ('${U2}', 'owner-guard-2', 'owner-guard-2@example.test')`,
    ),
  );
});
afterAll(() => db.drop());

/** A fresh organization with one owner (U1) and one plain member (U2). */
async function organization(admin: Client): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO app.organizations (id, name, slug, type) VALUES ($1, 'org', $2, 'team')`, [
    id,
    `org-${id.slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [id, U1, U2],
  );
  return id;
}

/** Runs the statements in one transaction and returns the commit's error, if any. */
async function commit(admin: Client, statements: string[]): Promise<Error | undefined> {
  await admin.query("BEGIN");
  try {
    for (const sql of statements) await admin.query(sql);
    await admin.query("COMMIT");
    return undefined;
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    return error as Error;
  }
}

const owners = async (admin: Client, org: string): Promise<number> =>
  (
    await admin.query(
      "SELECT count(*)::int AS n FROM app.organization_members WHERE organization_id = $1 AND org_role = 'owner'",
      [org],
    )
  ).rows[0].n;

describe("removing the last organization owner fails at commit", () => {
  it.each([
    [
      "deleting the last owner",
      (org: string) => [
        `DELETE FROM app.organization_members WHERE organization_id = '${org}' AND user_id = '${U1}'`,
      ],
    ],
    [
      "demoting the last owner",
      (org: string) => [
        `UPDATE app.organization_members SET org_role = 'member' WHERE organization_id = '${org}' AND user_id = '${U1}'`,
      ],
    ],
    [
      "deleting every member",
      (org: string) => [`DELETE FROM app.organization_members WHERE organization_id = '${org}'`],
    ],
    [
      "moving the last owner to another organization",
      (org: string) => {
        const other = randomUUID();
        return [
          `INSERT INTO app.organizations (id, name, slug, type) VALUES ('${other}', 'other', 'other-${other.slice(0, 8)}', 'team')`,
          `UPDATE app.organization_members SET organization_id = '${other}' WHERE organization_id = '${org}' AND user_id = '${U1}'`,
        ];
      },
    ],
  ])("%s is refused and the owner stays", async (_title, statements) => {
    await withAdminClient(env, db.name, async (admin) => {
      const org = await organization(admin);
      // 23514 is check_violation: any other error (a missing relation, say) must not pass as the refusal.
      expect(await commit(admin, statements(org))).toMatchObject({ code: "23514" });
      expect(await owners(admin, org)).toBe(1);
    });
  });
});

describe("changes that keep an owner commit", () => {
  it.each([
    [
      "deleting a member who is not an owner",
      (org: string) => [
        `DELETE FROM app.organization_members WHERE organization_id = '${org}' AND user_id = '${U2}'`,
      ],
    ],
    [
      "handing ownership over inside one transaction",
      (org: string) => [
        `UPDATE app.organization_members SET org_role = 'owner' WHERE organization_id = '${org}' AND user_id = '${U2}'`,
        `DELETE FROM app.organization_members WHERE organization_id = '${org}' AND user_id = '${U1}'`,
      ],
    ],
    [
      "deleting the organization with its members",
      (org: string) => [`DELETE FROM app.organizations WHERE id = '${org}'`],
    ],
  ])("%s commits", async (_title, statements) => {
    await withAdminClient(env, db.name, async (admin) => {
      const org = await organization(admin);
      expect(await commit(admin, statements(org))).toBeUndefined();
    });
  });
});
