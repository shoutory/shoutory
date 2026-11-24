import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { ACCEPT_CASES } from "../support/accept-cases.js";
import {
  asUser,
  attempt,
  commitAs as commit,
  digestOf,
  type Planted,
  plantInvitation,
  seedMembers,
  U,
  WA,
  WB,
} from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const rows = (sql: string, params?: unknown[]) =>
  withAdminClient(env, db.name, async (a) => (await a.query(sql, params)).rows);
const app = () => db.pool("app");
const inWorkspace = (user: string) => ({ ...asUser(user), workspaceIds: [WA] });
const CREATE = "SELECT app.invitation_create($1::uuid, $2, $3, $4::interval, $5::bytea, NULL, NULL) AS id";
const REVOKE = "SELECT app.invitation_revoke($1::uuid, $2::uuid, NULL, NULL)";
const ACCEPT = "SELECT app.invitation_accept($1::bytea, NULL, NULL) AS workspace_id";
const TAKE = "-m06a@example.test";
const VIEWER_ROLE = "(SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'viewer')";

const create = (caller: string, email: string, role: string, token: string, after?: [string, unknown[]]) =>
  attempt(app(), inWorkspace(caller), CREATE, [WA, email, role, "1 day", digestOf(token)], after);

const commitAs = (user: string, sql: string, params: unknown[]) => commit(app(), user, sql, params);

async function plant(row: Planted): Promise<string> {
  await withAdminClient(env, db.name, (admin) => plantInvitation(admin, row));
  const found = await rows("SELECT id FROM app.invitations WHERE token_hash = $1", [digestOf(row.token)]);
  return String(found[0]?.id);
}

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await withAdminClient(env, db.name, async (admin) => {
    await seedMembers(admin);
    await admin.query(
      "INSERT INTO app.roles (workspace_id, key, name, permissions) VALUES ($1, 'custom-m06a', 'Custom', '{}')",
      [WA],
    );
  });
});
afterAll(() => db.drop());

describe("an invitation above the inviter's role is refused", () => {
  it.each([
    ["owner", "admin", U.owner, null],
    ["owner", "owner", U.owner, "SH403"],
    ["admin", "admin", U.admin, null],
    ["admin", "owner", U.admin, "SH403"],
    ["editor", "approver", U.editor, "SH403"],
    ["editor", "admin", U.editor, "SH403"],
    ["implicit organization admin", "admin", U.orgAdmin, null],
    ["stored viewer who is an organization admin", "admin", U.viewerOrgAdmin, null],
    ["viewer", "editor", U.viewer, "SH403"],
    ["admin", "custom-m06a", U.admin, "42501"],
  ] as const)("the %s asks for the role %s", async (_label, role, caller, state) => {
    const result = await create(caller, `ceiling${TAKE}`, role, `c-${caller}-${role}`);
    if (state === null) return expect(result.rows?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.error).toMatchObject({ code: state });
    expect((result.error as Error).message).toMatch(/^invitation_create:/);
  });

  it("an expired pending row of the same email is revoked first; an unexpired one is a conflict", async () => {
    await withAdminClient(env, db.name, async (admin) => {
      await plantInvitation(admin, { token: "reinvite", email: `reinvite${TAKE}`, expires: "-1 hour" });
      await plantInvitation(admin, { token: "dup", email: `dup${TAKE}` });
    });
    const revoked =
      "SELECT count(*)::int AS n FROM app.invitations WHERE email = $1 AND revoked_at IS NOT NULL";
    const again = await create(U.admin, `reinvite${TAKE}`, "viewer", "reinvite-2", [
      revoked,
      [`reinvite${TAKE}`],
    ]);
    expect(again.after).toEqual([{ n: 1 }]);
    const duplicate = await create(U.admin, `dup${TAKE}`, "viewer", "dup-2");
    expect(duplicate.error).toMatchObject({ code: "SH409" });
  });

  it("the 101st pending invitation of a workspace is refused with 53400", async () => {
    await rows(
      `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, invited_by, expires_at)
       SELECT $1, 'bulk' || g || $2, ${VIEWER_ROLE}, sha256(convert_to('bulk' || g, 'UTF8')), $3,
         now() + interval '1 day' FROM generate_series(1, 100) AS g`,
      [WB, TAKE, U.bOwner],
    );
    const sql = [WB, `one-more${TAKE}`, "viewer", "1 day", digestOf("one-more")];
    const result = await attempt(app(), asUser(U.bOwner), CREATE, sql);
    expect(result.error).toMatchObject({ code: "53400" });
  });
});

describe("invitation_create and invitation_revoke bounds", () => {
  const at = (expires: string | null, email: string) =>
    attempt(
      app(),
      inWorkspace(U.admin),
      CREATE,
      [WA, email, "viewer", expires, digestOf(email)],
      [
        "SELECT abs(extract(epoch FROM expires_at - now() - interval '48 hours')) < 2 AS two_days FROM app.invitations WHERE email = $1",
        [email],
      ],
    );

  it.each(["59 minutes", "14 days 1 second"])("expires_in %s is refused with 22023", async (expires) => {
    const result = await at(expires, `bounds${TAKE}`);
    expect(result.error).toMatchObject({ code: "22023" });
    expect((result.error as Error).message).toMatch(/^invitation_create:/);
  });

  it("a null expires_in stores 48 hours from now", async () => {
    expect((await at(null, `default${TAKE}`)).after).toEqual([{ two_days: true }]);
  });

  it("a mixed-case email is stored lower-cased and the same address in another case is the pending duplicate", async () => {
    await withAdminClient(env, db.name, (admin) =>
      plantInvitation(admin, { token: "cased", email: `cased${TAKE}` }),
    );
    const read = "SELECT email FROM app.invitations WHERE email ILIKE $1";
    const stored = await create(U.admin, `Mixed${TAKE}`, "viewer", "mixed", [read, [`Mixed${TAKE}`]]);
    expect(stored.after).toEqual([{ email: `mixed${TAKE}` }]);
    expect((await create(U.admin, `CASED${TAKE}`, "viewer", "cased-2")).error).toMatchObject({
      code: "SH409",
    });
  });

  it.each([{ used: true }, { revoked: true }])(
    "revoking a row that is already ended (%o) is SH409",
    async (state) => {
      const token = `ended-${Object.keys(state)[0]}`;
      const id = await plant({ token, email: `${token}${TAKE}`, ...state });
      const result = await attempt(app(), asUser(U.admin), REVOKE, [WA, id]);
      expect(result.error).toMatchObject({ code: "SH409" });
      expect((result.error as Error).message).toMatch(/^invitation_revoke:/);
    },
  );
});

describe("a caller below admin cannot invite, revoke, change or remove another member", () => {
  const OTHER = "SELECT app.member_role_set($1::uuid, $2::uuid, 'viewer', NULL, NULL)";
  const OTHER_REMOVE = "SELECT app.member_remove($1::uuid, $2::uuid, NULL, NULL)";
  const CALLERS = [
    ["editor", U.editor],
    ["approver", U.approver],
    ["viewer", U.viewer],
  ] as const;
  const DEFINERS = ["invitation_create", "invitation_revoke", "member_role_set", "member_remove"] as const;

  it.each(CALLERS.flatMap(([label, user]) => DEFINERS.map((name) => [label, name, user] as const)))(
    "the %s calling %s is refused with SH403",
    async (_label, name, caller) => {
      const token = `rank-${name}-${caller}`;
      const id = await plant({ token, email: `${token}${TAKE}` });
      const call: Record<(typeof DEFINERS)[number], [string, unknown[]]> = {
        invitation_create: [CREATE, [WA, `rank${TAKE}`, "viewer", "1 day", digestOf(token)]],
        invitation_revoke: [REVOKE, [WA, id]],
        member_role_set: [OTHER, [WA, U.alreadyMember]],
        member_remove: [OTHER_REMOVE, [WA, U.alreadyMember]],
      };
      const result = await attempt(app(), asUser(caller), ...call[name]);
      expect(result.error).toMatchObject({ code: "SH403" });
      expect((result.error as Error).message).toMatch(new RegExp(`^${name}:`));
    },
  );
});

describe("accept: the answers are fixed by who asks and in what state the row is", () => {
  const COUNT = "SELECT count(*)::int AS n FROM app.workspace_members";

  it.each(ACCEPT_CASES)("$title", async ({ title, planted, caller, mutate, state, message }) => {
    const token = `accept-${title}`;
    await withAdminClient(env, db.name, async (admin) => {
      if (planted) await plantInvitation(admin, { ...planted, token });
      if (mutate) await admin.query(mutate);
    });
    const before = await rows(COUNT);
    const result = await attempt(app(), asUser(caller), ACCEPT, [digestOf(token)]);
    expect(result.error).toMatchObject({ code: state });
    expect((result.error as Error).message).toMatch(message);
    expect(await rows(COUNT)).toEqual(before);
  });

  it("a forged token, a planted owner row and a non-built-in role row answer with one identical message", async () => {
    const tokens = ACCEPT_CASES.slice(0, 3).map((c) => `accept-${c.title}`);
    const messages = await Promise.all(
      tokens.map(async (token) => {
        const result = await attempt(app(), asUser(U.invitee), ACCEPT, [digestOf(token)]);
        return (result.error as Error).message;
      }),
    );
    expect(new Set(messages).size).toBe(1);
  });
});

describe("accept compares addresses in lower case", () => {
  it("an account whose stored address has capitals still accepts its invitation", async () => {
    // The column's CHECK keeps addresses lower-case; this clone drops it to prove the definer does not rely on it.
    await withAdminClient(env, db.name, async (admin) => {
      await admin.query('ALTER TABLE auth."user" DROP CONSTRAINT user_email_check');
      await admin.query('UPDATE auth."user" SET email = $2 WHERE id = $1', [U.orgOwner, `OrgOwner${TAKE}`]);
      await plantInvitation(admin, { token: "accept-cased", email: `orgowner${TAKE}`, role: "viewer" });
    });
    const joined = await commitAs(U.orgOwner, ACCEPT, [digestOf("accept-cased")]);
    expect(joined[0]?.workspace_id).toBe(WA);
  });
});

describe("accept consumes the row once and adds one member", () => {
  const COUNTS = `SELECT (SELECT count(*)::int FROM app.organizations) AS orgs,
    (SELECT count(*)::int FROM app.workspaces) AS ws,
    (SELECT count(*)::int FROM app.organization_members) AS org_members,
    (SELECT count(*)::int FROM app.workspace_members) AS members`;

  it("the invited account joins with the role of the row and nothing else is created", async () => {
    await withAdminClient(env, db.name, (admin) =>
      plantInvitation(admin, { token: "accept-ok", role: "editor" }),
    );
    const before = (await rows(COUNTS))[0] as Record<string, number>;
    const joined = (await commitAs(U.invitee, ACCEPT, [digestOf("accept-ok")]))[0]?.workspace_id;
    expect(joined).toBe(WA);
    expect(await rows(COUNTS)).toEqual([{ ...before, members: (before.members ?? 0) + 1 }]);
    const member = `SELECT r.key, m.status FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id
      WHERE m.workspace_id = $1 AND m.user_id = $2`;
    expect(await rows(member, [WA, U.invitee])).toEqual([{ key: "editor", status: "active" }]);
  });

  it("two concurrent accepts of one token add exactly one member", async () => {
    await withAdminClient(env, db.name, (admin) =>
      plantInvitation(admin, { token: "accept-race", email: `racer${TAKE}`, role: "viewer" }),
    );
    const outcome = await holdThenRace(
      rows,
      await openTx(app(), asUser(U.racer)),
      await openTx(app(), asUser(U.racer)),
      (client) => client.query(ACCEPT, [digestOf("accept-race")]),
    );
    expect(outcome.secondError).toMatchObject({ code: "SH410" });
    const members = "SELECT count(*)::int AS n FROM app.workspace_members WHERE user_id = $1";
    expect(await rows(members, [U.racer])).toEqual([{ n: 1 }]);
  });
});

describe("the token digest is stored and the app role reads and writes only what it should", () => {
  const CANARY = "plaintext-token-canary-m06a";
  const OWNER_ROLE = "(SELECT id FROM app.roles WHERE key = 'owner')";

  it("the digest is stored, the plaintext canary is absent from every column, token_hash is unreadable", async () => {
    await commitAs(U.admin, CREATE, [WA, `canary${TAKE}`, "viewer", "1 day", digestOf(CANARY)]);
    const forms = [CANARY, Buffer.from(CANARY).toString("hex"), Buffer.from(CANARY).toString("base64")];
    const stored = await rows(
      "SELECT i::text AS everything, encode(token_hash, 'hex') AS hex FROM app.invitations i WHERE email = $1",
      [`canary${TAKE}`],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hex).toBe(digestOf(CANARY).toString("hex"));
    for (const form of forms) expect(String(stored[0]?.everything)).not.toContain(form);
    for (const sql of ["SELECT token_hash FROM app.invitations", "SELECT * FROM app.invitations"]) {
      expect((await attempt(app(), inWorkspace(U.admin), sql)).error).toMatchObject({ code: "42501" });
    }
    const readable = "SELECT email, expires_at FROM app.invitations";
    expect((await attempt(app(), inWorkspace(U.admin), readable)).rows?.length).toBeGreaterThan(0);
  });

  it.each([
    [
      "insert a member",
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES ($1, $2, ${OWNER_ROLE})`,
    ],
    [
      "change a member's role",
      `UPDATE app.workspace_members SET role_id = ${OWNER_ROLE} WHERE workspace_id = $1 AND user_id = $2`,
    ],
    ["delete a member", "DELETE FROM app.workspace_members WHERE workspace_id = $1 AND user_id = $2"],
    [
      "change an invitation",
      "UPDATE app.invitations SET revoked_at = now() WHERE workspace_id = $1 AND invited_by = $2",
    ],
  ])("the app role cannot %s", async (_title, sql) => {
    const ctx = { ...inWorkspace(U.owner), writeWorkspaceId: WA };
    expect((await attempt(app(), ctx, sql, [WA, U.viewer])).error).toMatchObject({ code: "42501" });
  });
});

describe("a caller outside the workspace gets the same 42501 and message for a real and a missing target", () => {
  type Args = (ws: string, victim: string) => unknown[];
  const pair: Args = (ws, victim) => [ws, victim];
  const SET_ROLE = "SELECT app.member_role_set($1::uuid, $2::uuid, 'viewer', NULL, NULL)";
  const REMOVE = "SELECT app.member_remove($1::uuid, $2::uuid, NULL, NULL)";
  const DEFINERS: [string, string, Args][] = [
    ["invitation_create", CREATE, (ws) => [ws, `probe${TAKE}`, "viewer", "1 day", Buffer.alloc(32, 9)]],
    ["invitation_revoke", REVOKE, pair],
    ["member_role_set", SET_ROLE, pair],
    ["member_remove", REMOVE, pair],
  ];

  it.each(DEFINERS)("%s", async (name, sql, args) => {
    const token = `e1-${name}`;
    await withAdminClient(env, db.name, (admin) =>
      plantInvitation(admin, { token, email: `${token}${TAKE}` }),
    );
    const planted = await rows("SELECT id FROM app.invitations WHERE token_hash = $1", [digestOf(token)]);
    const real = name === "invitation_revoke" ? String(planted[0]?.id) : U.viewer;
    const scenarios: [string, unknown[]][] = [
      [U.outsider, args(WA, real)],
      [U.outsider, args(randomUUID(), real)],
    ];
    if (name !== "invitation_create") scenarios.push([U.admin, args(WA, randomUUID())]);
    const errors = await Promise.all(
      scenarios.map(async ([caller, params]) => (await attempt(app(), asUser(caller), sql, params)).error),
    );
    for (const error of errors) expect(error).toMatchObject({ code: "42501" });
    expect(new Set(errors.map((e) => (e as Error).message)).size).toBe(1);
    expect((errors[0] as Error).message).toMatch(new RegExp(`^${name}:`));
  });
});
