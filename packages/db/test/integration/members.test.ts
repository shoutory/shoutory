import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import {
  asUser,
  attempt,
  commitAs,
  digestOf,
  OA,
  plantInvitation,
  seedMembers,
  U,
  WA,
} from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Every row runs in a transaction that is rolled back, so rows share one fixture.
let db: TestDatabase;
const rows = (sql: string, params?: unknown[]) =>
  withAdminClient(env, db.name, async (a) => (await a.query(sql, params)).rows);
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await withAdminClient(env, db.name, seedMembers);
});
afterAll(() => db.drop());

const SET_ROLE = "SELECT app.member_role_set($1::uuid, $2::uuid, $3, NULL, NULL)";
const REMOVE = "SELECT app.member_remove($1::uuid, $2::uuid, NULL, NULL)";

describe("a member changes or removes only members strictly below them; the new role is at most their own", () => {
  // The new role is null for a removal; the SQLSTATE is null for success.
  it.each([
    ["admin sets an editor to approver", U.admin, U.editor, "approver", null],
    ["admin sets a viewer to admin (at most their own)", U.admin, U.viewer, "admin", null],
    ["admin removes an editor", U.admin, U.editor, null, null],
    ["an implicit organization admin sets an editor to viewer", U.orgAdmin, U.editor, "viewer", null],
    ["an editor removes themselves (leave)", U.editor, U.editor, null, null],
    ["a viewer leaves (no rank needed)", U.viewer, U.viewer, null, null],
    ["admin makes an owner through a role change", U.admin, U.editor, "owner", "SH403"],
    ["editor sets a viewer to admin (above their own)", U.editor, U.viewer, "admin", "SH403"],
    ["editor sets an admin to viewer (target above)", U.editor, U.admin, "viewer", "SH403"],
    ["admin sets a peer admin to editor (not strictly below)", U.admin, U.admin2, "editor", "SH403"],
    ["admin removes a peer admin", U.admin, U.admin2, null, "SH403"],
    [
      "admin changes a stored viewer who is an organization Admin (effective admin)",
      U.admin,
      U.viewerOrgAdmin,
      "editor",
      "SH403",
    ],
    [
      "admin removes a stored viewer who is an organization Admin (effective admin)",
      U.admin,
      U.viewerOrgAdmin,
      null,
      "SH403",
    ],
    ["an implicit admin has no stored row to leave", U.orgAdmin, U.orgAdmin, null, "SH403"],
    ["a role key that is not a built-in role", U.admin, U.editor, "custom-role", "42501"],
    ["a target that is not a member", U.admin, U.outsider, "viewer", "42501"],
    ["a removal of a target that is not a member", U.admin, U.outsider, null, "42501"],
    ["a caller outside the workspace", U.outsider, U.viewer, "editor", "42501"],
  ] as const)("%s", async (_title, caller, target, role, state) => {
    const sql = role === null ? REMOVE : SET_ROLE;
    const params = role === null ? [WA, target] : [WA, target, role];
    const result = await attempt(db.pool("app"), asUser(caller), sql, params);
    if (state === null) {
      expect(result.error).toBeUndefined();
      return;
    }
    expect(result.error).toMatchObject({ code: state });
    expect((result.error as Error).message).toMatch(role === null ? /^member_remove:/ : /^member_role_set:/);
  });
});

describe("the stored Owner cannot be removed, demoted or leave; exactly one stored Owner holds at commit", () => {
  it.each([
    ["the Owner leaves", U.owner, REMOVE, [WA, U.owner], "SH409"],
    ["the Owner demotes themselves", U.owner, SET_ROLE, [WA, U.owner, "admin"], "SH409"],
    ["an admin removes the Owner", U.admin, REMOVE, [WA, U.owner], "SH403"],
    ["an admin demotes the Owner", U.admin, SET_ROLE, [WA, U.owner, "viewer"], "SH403"],
    ["an admin makes an editor Owner", U.admin, SET_ROLE, [WA, U.editor, "owner"], "SH403"],
    ["the Owner transfers to a non-member", U.owner, SET_ROLE, [WA, U.outsider, "owner"], "42501"],
  ] as const)("%s", async (_title, caller, sql, params, state) => {
    const result = await attempt(db.pool("app"), asUser(caller), sql, [...params]);
    expect(result.error).toMatchObject({ code: state });
  });

  it("the transfer makes the target Owner and the caller admin in one transaction", async () => {
    const result = await attempt(
      db.pool("app"),
      { ...asUser(U.owner), workspaceIds: [WA] },
      SET_ROLE,
      [WA, U.editor, "owner"],
      [
        `SELECT m.user_id, r.key FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id
         WHERE m.workspace_id = $1 AND m.user_id IN ($2, $3) ORDER BY r.key`,
        [WA, U.owner, U.editor],
      ],
    );
    expect(result.error).toBeUndefined();
    expect(result.after).toEqual([
      { user_id: U.owner, key: "admin" },
      { user_id: U.editor, key: "owner" },
    ]);
  });
});

describe("the commit-time Owner guard under the definers", () => {
  // A commit that leaves a workspace with no Owner or two Owners is refused.
  const newWorkspace = async (admin: Client): Promise<string> => {
    const ws = randomUUID();
    await admin.query(
      `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, (SELECT organization_id FROM app.workspaces WHERE id = $2), 'guard', $3)`,
      [ws, WA, `guard-${ws.slice(0, 8)}`],
    );
    await admin.query(
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES
         ($1, $2, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'owner')),
         ($1, $3, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'viewer'))`,
      [ws, U.owner, U.viewer],
    );
    return ws;
  };

  const OWNER_ROLE = "(SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'owner')";
  it.each([
    [
      "deleting the only Owner row",
      `DELETE FROM app.workspace_members WHERE workspace_id = $1 AND user_id = '${U.owner}'`,
      "23514",
    ],
    [
      "a second Owner row",
      `UPDATE app.workspace_members SET role_id = ${OWNER_ROLE} WHERE workspace_id = $1 AND user_id = '${U.viewer}'`,
      "23514",
    ],
    [
      "deleting the workspace with its Owner (cascade purge)",
      "DELETE FROM app.workspaces WHERE id = $1",
      null,
    ],
  ] as const)("a commit with %s", async (_title, sql, state) => {
    await withAdminClient(env, db.name, async (admin) => {
      const ws = await newWorkspace(admin);
      await admin.query("BEGIN");
      await admin.query(sql, [ws]);
      const commit = admin.query("COMMIT");
      if (state === null) await expect(commit).resolves.toBeDefined();
      else await expect(commit).rejects.toMatchObject({ code: state });
      await admin.query("ROLLBACK");
    });
  });
});

describe("a suspended stored Owner is still the Owner", () => {
  const W1 = randomUUID();
  const W2 = randomUUID();
  // The Owner row goes first in each workspace: the guard checks every commit.
  const SEATS = [
    [W1, U.racer, "owner", "suspended"],
    [W1, U.admin, "admin", "active"],
    [W2, U.viewerOrgAdmin, "owner", "suspended"],
    [W2, U.editor, "editor", "active"],
  ];
  beforeAll(async () => {
    await withAdminClient(env, db.name, async (admin) => {
      for (const ws of [W1, W2]) {
        await admin.query(
          "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'suspended', $3)",
          [ws, OA, `suspended-${ws.slice(0, 8)}`],
        );
      }
      for (const [ws, user, key, status] of SEATS) {
        await admin.query(
          `INSERT INTO app.workspace_members (workspace_id, user_id, role_id, status)
           VALUES ($1, $2, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = $3), $4)`,
          [ws, user, key, status],
        );
      }
    });
  });

  it.each([
    ["an admin removes a suspended Owner", U.admin, REMOVE, [W1, U.racer]],
    ["an admin changes the role of a suspended Owner", U.admin, SET_ROLE, [W1, U.racer, "editor"]],
    [
      "a suspended Owner who is an organization admin cannot transfer",
      U.viewerOrgAdmin,
      SET_ROLE,
      [W2, U.editor, "owner"],
    ],
  ] as const)("%s: SH403, never a commit-time 23514", async (_title, caller, sql, params) => {
    const result = await attempt(db.pool("app"), asUser(caller), sql, [...params]);
    expect(result.error).toMatchObject({ code: "SH403" });
  });
});

describe("concurrent Owner transfers", () => {
  it("two concurrent transfers by the Owner leave exactly one Owner and refuse the second", async () => {
    const outcome = await holdThenRace(
      rows,
      await openTx(db.pool("app"), asUser(U.owner)),
      await openTx(db.pool("app"), asUser(U.owner)),
      (client, n) => client.query(SET_ROLE, [WA, n === 1 ? U.admin : U.editor, "owner"]),
    );
    expect(outcome.secondError).toMatchObject({ code: "SH403" });
    const owners = await rows(
      "SELECT m.user_id FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id WHERE m.workspace_id = $1 AND r.key = 'owner'",
      [WA],
    );
    expect(owners).toEqual([{ user_id: U.admin }]);
  });
});

describe("the organization row lock: the tenancy definers lock without updating; an actual UPDATE of organizations or workspaces fails", () => {
  const ORG_OF_WA = "(SELECT organization_id FROM app.workspaces WHERE id = $1)";
  it.each([
    [
      "a workspace name",
      "UPDATE app.workspaces SET name = 'x' WHERE id = $1",
      "SELECT id FROM app.workspaces WHERE id = $1 FOR NO KEY UPDATE",
    ],
    [
      "a workspace id",
      "UPDATE app.workspaces SET id = id WHERE id = $1",
      "SELECT id FROM app.workspaces WHERE id = $1 FOR NO KEY UPDATE",
    ],
    [
      "an organization id",
      `UPDATE app.organizations SET id = id WHERE id = ${ORG_OF_WA}`,
      `SELECT id FROM app.organizations WHERE id = ${ORG_OF_WA} FOR NO KEY UPDATE`,
    ],
  ] as const)(
    "an UPDATE of %s fails for the definer role while the row lock passes",
    async (_title, update, lock) => {
      await withAdminClient(env, db.name, async (admin) => {
        await admin.query("BEGIN");
        await admin.query("SET LOCAL ROLE shoutory_definer");
        await admin.query("SELECT set_config('app.job_purpose', 'invitation_create', true)");
        expect((await admin.query(lock, [WA])).rows).toHaveLength(1);
        await expect(admin.query(update, [WA])).rejects.toMatchObject({ code: "42501" });
        await admin.query("ROLLBACK");
      });
    },
  );

  it("an open invitation_create holds the organization row and then the workspace row", async () => {
    const client = await openTx(db.pool("app"), asUser(U.admin));
    try {
      await client.query(
        "SELECT app.invitation_create($1::uuid, 'lock-m06a@example.test', 'viewer', '1 day', $2, NULL, NULL)",
        [WA, Buffer.alloc(32, 7)],
      );
      for (const sql of [
        "SELECT 1 FROM app.workspaces WHERE id = $1 FOR UPDATE NOWAIT",
        "SELECT 1 FROM app.organizations WHERE id = (SELECT organization_id FROM app.workspaces WHERE id = $1) FOR UPDATE NOWAIT",
      ]) {
        await expect(withAdminClient(env, db.name, (a) => a.query(sql, [WA]))).rejects.toMatchObject({
          code: "55P03",
        });
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

async function seedAuditWorkspace(admin: Client, ws: string): Promise<string> {
  await admin.query(
    "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'audit', 'audit-m06a')",
    [ws, OA],
  );
  const members = [
    [U.owner, "owner"],
    [U.admin, "admin"],
    [U.editor, "editor"],
    [U.approver, "approver"],
    [U.viewer, "viewer"],
  ];
  for (const [user, key] of members) {
    await admin.query(
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       VALUES ($1, $2, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = $3))`,
      [ws, user, key],
    );
  }
  await plantInvitation(admin, { ws, token: "audit-accepted", role: "viewer" });
  const email = "audit-revoked-m06a@example.test";
  await plantInvitation(admin, { ws, token: "audit-revoked", email });
  const found = await admin.query("SELECT id FROM app.invitations WHERE token_hash = $1", [
    digestOf("audit-revoked"),
  ]);
  return String(found.rows[0]?.id);
}

describe("each definer writes its audit row with the caller as actor", () => {
  const WS = randomUUID();
  const created: { id?: string } = {};
  const CREATE = "SELECT app.invitation_create($1::uuid, $2, 'viewer', '1 day', $3::bytea, NULL, NULL) AS id";
  const ACCEPT = "SELECT app.invitation_accept($1::bytea, NULL, NULL) AS id";
  const REVOKE = "SELECT app.invitation_revoke($1::uuid, $2::uuid, NULL, NULL) AS id";
  const SET = "SELECT app.member_role_set($1::uuid, $2::uuid, $3, NULL, NULL) AS id";
  const DROP = "SELECT app.member_remove($1::uuid, $2::uuid, NULL, NULL) AS id";
  // Each row commits, so the rows run in this order on one workspace.
  const ROWS: [string, string, string, () => unknown[]][] = [
    [
      "invitation.created",
      U.admin,
      CREATE,
      () => [WS, "audit-created-m06a@example.test", digestOf("created")],
    ],
    ["invitation.revoked", U.admin, REVOKE, () => [WS, created.id]],
    ["invitation.accepted", U.invitee, ACCEPT, () => [digestOf("audit-accepted")]],
    ["member.role_changed", U.admin, SET, () => [WS, U.editor, "viewer"]],
    ["member.removed", U.admin, DROP, () => [WS, U.viewer]],
    ["member.left", U.approver, DROP, () => [WS, U.approver]],
    ["workspace.owner_transferred", U.owner, SET, () => [WS, U.admin, "owner"]],
  ];

  beforeAll(async () => {
    created.id = await withAdminClient(env, db.name, (admin) => seedAuditWorkspace(admin, WS));
  });

  it.each(ROWS)("%s", async (action, caller, sql, args) => {
    await commitAs(db.pool("app"), caller, sql, args());
    const logged = await rows(
      "SELECT actor_kind, actor_ref FROM app.audit_logs WHERE workspace_id = $1 AND action = $2",
      [WS, action],
    );
    expect(logged).toEqual([{ actor_kind: "user", actor_ref: caller }]);
  });
});
