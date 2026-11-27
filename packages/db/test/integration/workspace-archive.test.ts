import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import {
  asUser,
  attempt,
  digestOf,
  OA,
  OB,
  plantInvitation,
  seedMembers,
  U,
  WA,
  WB,
} from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

async function commit(ctx: TenantCtx, sql: string, params: unknown[] = [], pool: "app" | "worker" = "app") {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const answer = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return answer;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const tryAs = (user: string, sql: string, params: unknown[] = []) =>
  attempt(db.pool("app"), asUser(user), sql, params);
const codeOf = (outcome: { error?: unknown }) => (outcome.error as { code?: string } | undefined)?.code;

// A fresh workspace of OA with the same members as WA, so one test's archive never changes another's.
async function freshWorkspace(): Promise<string> {
  const [made] = await rows(
    `WITH w AS (INSERT INTO app.workspaces (organization_id, name, slug) VALUES ($1, 'fresh', $2) RETURNING id)
     INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       SELECT w.id, m.user_id, m.role_id FROM w, app.workspace_members m WHERE m.workspace_id = $3 RETURNING workspace_id`,
    [OA, `fresh-${randomUUID().slice(0, 8)}`, WA],
  );
  return made?.workspace_id as string;
}
const ARCHIVE = "SELECT app.workspace_archive($1, 'req-archive', NULL)";
const UNARCHIVE = "SELECT app.workspace_unarchive($1, 'req-unarchive', NULL)";
const archivedAt = async (ws: string) =>
  (await rows("SELECT archived_at FROM app.workspaces WHERE id = $1", [ws]))[0]?.archived_at;
const auditOf = (ws: string) =>
  rows(
    "SELECT action FROM app.audit_logs WHERE workspace_id = $1 AND action LIKE 'workspace.%' ORDER BY at, id",
    [ws],
  );

const BELOW = [
  ["a viewer", U.viewer, "SH403"],
  ["an approver", U.approver, "SH403"],
  ["an editor", U.editor, "SH403"],
  ["an outsider", U.outsider, "42501"],
  ["another organization's owner", U.bOwner, "42501"],
] as const;
const ALLOWED = [
  ["the workspace admin", U.admin],
  ["the workspace owner", U.owner],
  ["an organization admin with no workspace row", U.orgAdmin],
  ["the organization owner", U.orgOwner],
] as const;

describe("workspace_archive and workspace_unarchive", () => {
  it.each(
    BELOW.flatMap(([who, user, code]) => [
      ["archive", who, user, code],
      ["unarchive", who, user, code],
    ]),
  )("refuse %s by %s and change nothing", async (verb, _who, user, code) => {
    const ws = await freshWorkspace();
    if (verb === "unarchive") await commit(asUser(U.owner), ARCHIVE, [ws]);
    const before = await archivedAt(ws);
    expect(codeOf(await tryAs(user, verb === "archive" ? ARCHIVE : UNARCHIVE, [ws]))).toBe(code);
    expect(await archivedAt(ws)).toEqual(before);
  });

  it("answer a missing workspace like a foreign one", async () => {
    expect(codeOf(await tryAs(U.bOwner, ARCHIVE, [WA]))).toBe("42501");
    expect(codeOf(await tryAs(U.bOwner, ARCHIVE, [randomUUID()]))).toBe("42501");
  });

  it.each(ALLOWED)("let %s archive and restore", async (_who, user) => {
    const ws = await freshWorkspace();
    await commit(asUser(user), ARCHIVE, [ws]);
    expect(await archivedAt(ws)).not.toBeNull();
    await commit(asUser(user), UNARCHIVE, [ws]);
    expect(await archivedAt(ws)).toBeNull();
  });
});

describe("what archive and unarchive write", () => {
  it("write one audit row each, and a repeat is a no-op with no second row", async () => {
    const ws = await freshWorkspace();
    await commit(asUser(U.admin), ARCHIVE, [ws]);
    const first = await archivedAt(ws);
    await commit(asUser(U.admin), ARCHIVE, [ws]);
    expect(await archivedAt(ws)).toEqual(first);
    await commit(asUser(U.admin), UNARCHIVE, [ws]);
    await commit(asUser(U.admin), UNARCHIVE, [ws]);
    expect(await auditOf(ws)).toEqual([{ action: "workspace.archived" }, { action: "workspace.restored" }]);
  });

  it("refuse to archive a workspace whose deletion is requested", async () => {
    const ws = await freshWorkspace();
    await rows("UPDATE app.workspaces SET deletion_requested_at = now() WHERE id = $1", [ws]);
    const outcome = await tryAs(U.owner, ARCHIVE, [ws]);
    expect(outcome.error).toMatchObject({ code: "SH409", message: "workspace_archive: deletion_requested" });
  });

  it("keep every row of history: members and posts stay and the workspace still reads by id", async () => {
    const ws = await freshWorkspace();
    await rows("INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2)", [
      ws,
      U.editor,
    ]);
    const count = `SELECT (SELECT count(*) FROM app.workspace_members WHERE workspace_id = $1)::int AS members,
      (SELECT count(*) FROM app.posts WHERE workspace_id = $1)::int AS posts`;
    const before = await rows(count, [ws]);
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    expect(await rows(count, [ws])).toEqual(before);
    const read = {
      organizationId: OA,
      workspaceIds: [ws],
      principalKind: "user",
      principalId: U.viewer,
    } as const;
    expect(await commit(read, "SELECT id FROM app.workspaces WHERE id = $1", [ws])).toEqual([{ id: ws }]);
  });
});

describe("an archived workspace refuses a direct change", () => {
  it.each([
    ["name", "name = 'renamed'"],
    ["zone", "default_tz = 'Africa/Cairo'"],
  ])("an UPDATE of the %s as the app role answers SH409 workspace_archived", async (_label, set) => {
    const ws = await freshWorkspace();
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    const writer = {
      organizationId: OA,
      workspaceIds: [ws],
      writeWorkspaceId: ws,
      principalKind: "user",
    } as const;
    const outcome = await attempt(
      db.pool("app"),
      { ...writer, principalId: U.owner },
      `UPDATE app.workspaces SET ${set} WHERE id = $1`,
      [ws],
    );
    expect(outcome.error).toMatchObject({ code: "SH409", message: "workspace_guard: workspace_archived" });
  });

  it.each([
    ["workspace_avatar_set", "SELECT app.workspace_avatar_set($1, NULL)"],
    ["member_role_set", `SELECT app.member_role_set($1, '${U.editor}', 'viewer', 'req-role', NULL)`],
    ["member_remove", `SELECT app.member_remove($1, '${U.editor}', 'req-remove', NULL)`],
    ["channel_disable", `SELECT app.channel_disable($1, '${randomUUID()}', 'req-disable', NULL)`],
  ])("%s is refused on an archived workspace", async (name, sql) => {
    const ws = await freshWorkspace();
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    const outcome = await tryAs(U.owner, sql, [ws]);
    expect(outcome.error).toMatchObject({ code: "SH409", message: `${name}: workspace_archived` });
  });

  it("accepting an invitation to an archived workspace is refused", async () => {
    const ws = await freshWorkspace();
    await admin((client) => plantInvitation(client, { token: "archived-accept", ws }));
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    const outcome = await tryAs(U.invitee, "SELECT app.invitation_accept($1, 'req-accept', NULL)", [
      digestOf("archived-accept"),
    ]);
    expect(outcome.error).toMatchObject({ code: "SH409", message: "invitation_accept: workspace_archived" });
  });
});

describe("workspace_avatar_set", () => {
  const SET = "SELECT app.workspace_avatar_set($1, $2)";
  async function asset(ws: string, o: { mime?: string; state?: string } = {}): Promise<string> {
    const [made] = await rows(
      `INSERT INTO app.media_assets (workspace_id, object_key, file_name, mime, byte_size, sha256, state, source, created_by,
         deleted_at)
       VALUES ($1::uuid, 'ws/' || $1::text || '/' || gen_random_uuid(), 'a.png', $2, 10,
         sha256(gen_random_uuid()::text::bytea), $3::text, 'upload', $4, CASE WHEN $3::text = 'deleted' THEN now() END)
       RETURNING id`,
      [ws, o.mime ?? "image/png", o.state ?? "ready", U.editor],
    );
    return made?.id as string;
  }
  const avatarOf = async (ws: string) =>
    (await rows("SELECT avatar FROM app.workspaces WHERE id = $1", [ws]))[0]?.avatar;

  it("sets a ready image of the same workspace and clears it with null", async () => {
    const ws = await freshWorkspace();
    const image = await asset(ws);
    await commit(asUser(U.admin), SET, [ws, image]);
    expect(await avatarOf(ws)).toBe(image);
    await commit(asUser(U.admin), SET, [ws, null]);
    expect(await avatarOf(ws)).toBeNull();
  });

  it.each([
    ["another workspace's image", "42501", async () => asset(WB)],
    ["a deleted image", "42501", async (ws: string) => asset(ws, { state: "deleted" })],
    ["an unknown id", "42501", async () => randomUUID()],
    ["a video", "SH422", async (ws: string) => asset(ws, { mime: "video/mp4" })],
    ["an image still processing", "SH422", async (ws: string) => asset(ws, { state: "processing" })],
  ])("refuses %s with %s and leaves the avatar", async (_label, code, make) => {
    const ws = await freshWorkspace();
    const media = await make(ws);
    expect(codeOf(await tryAs(U.admin, SET, [ws, media]))).toBe(code);
    expect(await avatarOf(ws)).toBeNull();
  });

  it.each(BELOW)("refuses %s", async (_who, user, code) => {
    const ws = await freshWorkspace();
    expect(codeOf(await tryAs(user, SET, [ws, null]))).toBe(code);
  });

  it("media_delete still refuses the avatar", async () => {
    const ws = await freshWorkspace();
    const image = await asset(ws);
    await commit(asUser(U.admin), SET, [ws, image]);
    const outcome = await tryAs(U.admin, "SELECT app.media_delete($1, $2)", [ws, image]);
    expect(outcome.error).toMatchObject({ code: "SH409", message: "media_delete: in_use" });
  });
});

const ORG_CREATE = "SELECT * FROM app.organization_create($1, 'team', NULL, NULL, $2, $3)";
const WS_CREATE = `SELECT * FROM app.workspace_create($1, $2, $3, $4, NULL, NULL,
  encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), $5, $6, $7)`;
const bucket = () => randomUUID().replaceAll("-", "").repeat(2);
const uuidv7 = async () => (await rows("SELECT uuidv7()::text AS id"))[0]?.id as string;

describe("the create key", () => {
  it("a workspace create retried with the same key and body returns the first row and makes one row", async () => {
    const key = await uuidv7();
    const args = [OA, "keyed", `keyed-${key.slice(-8)}`, "UTC", key, null, false];
    const first = await commit(asUser(U.orgOwner), WS_CREATE, args);
    const again = await commit(asUser(U.orgOwner), WS_CREATE, args);
    expect(first[0]).toMatchObject({ id: key, replayed: false });
    expect(again[0]).toMatchObject({ id: key, replayed: true, slug: first[0]?.slug });
    expect(await rows("SELECT count(*)::int AS n FROM app.workspaces WHERE id = $1", [key])).toEqual([
      { n: 1 },
    ]);
  });

  it.each([
    ["another caller", U.orgAdmin, "keyed"],
    ["another body", U.orgOwner, "renamed"],
  ])(
    "the same workspace key from %s answers SH422 idempotency_key_reused and creates nothing",
    async (_l, user, name) => {
      const key = await uuidv7();
      const args = (named: string) => [OA, named, `k-${key.slice(-8)}`, "UTC", key, null, false];
      await commit(asUser(U.orgOwner), WS_CREATE, args("keyed"));
      const outcome = await tryAs(user, WS_CREATE, args(name));
      expect(outcome.error).toMatchObject({
        code: "SH422",
        message: "workspace_create: idempotency_key_reused",
      });
    },
  );
});

describe("the organization create key and malformed keys", () => {
  it("an organization create retried with the same key returns it; another caller's reuse is refused", async () => {
    const key = await uuidv7();
    const first = await commit(asUser(U.outsider), ORG_CREATE, ["keyed-org", bucket(), key]);
    const again = await commit(asUser(U.outsider), ORG_CREATE, ["keyed-org", bucket(), key]);
    expect([first[0], again[0]]).toEqual([
      { id: key, replayed: false },
      { id: key, replayed: true },
    ]);
    const other = await tryAs(U.racer, ORG_CREATE, ["keyed-org", bucket(), key]);
    expect(other.error).toMatchObject({
      code: "SH422",
      message: "organization_create: idempotency_key_reused",
    });
    expect(await rows("SELECT count(*)::int AS n FROM app.organizations WHERE id = $1", [key])).toEqual([
      { n: 1 },
    ]);
  });

  it.each([
    ["a version 4 id", randomUUID()],
    ["the nil id", "00000000-0000-0000-0000-000000000000"],
  ])("refuses %s as a key with 22023", async (_label, key) => {
    expect(codeOf(await tryAs(U.outsider, ORG_CREATE, ["bad-key", bucket(), key]))).toBe("22023");
    expect(
      codeOf(await tryAs(U.orgOwner, WS_CREATE, [OA, "bad-key", "bad-key", "UTC", key, null, false])),
    ).toBe("22023");
  });
});

describe("the organization create key and the rate bucket", () => {
  it("two concurrent creates with one key make one organization, one replay, and spend one token", async () => {
    const [key, spend] = [await uuidv7(), bucket()];
    const answers: Record<string, unknown>[] = [];
    const race = await holdThenRace(
      rows,
      await openTx(db.pool("app"), asUser(U.outsider)),
      await openTx(db.pool("app"), asUser(U.outsider)),
      async (client) => answers.push(...(await client.query(ORG_CREATE, ["raced-org", spend, key])).rows),
    );
    expect(race.secondError).toBeUndefined();
    expect(answers).toEqual([
      { id: key, replayed: false },
      { id: key, replayed: true },
    ]);
    expect(
      await rows(
        `SELECT (SELECT capacity FROM app.bucket_limits('tenant_create')) - round(tokens)::int AS spent
           FROM app.rate_buckets WHERE scope = 'tenant_create' AND key = $1`,
        [spend],
      ),
    ).toEqual([{ spent: 1 }]);
  });

  it("a replay is answered even when the bucket is empty, while a new key is rate limited", async () => {
    const [key, spend] = [await uuidv7(), bucket()];
    await commit(asUser(U.outsider), ORG_CREATE, ["drained-org", spend, key]);
    await rows(
      "UPDATE app.rate_buckets SET tokens = 0, refilled_at = clock_timestamp() WHERE scope = 'tenant_create' AND key = $1",
      [spend],
    );
    const again = await commit(asUser(U.outsider), ORG_CREATE, ["drained-org", spend, key]);
    expect(again).toEqual([{ id: key, replayed: true }]);
    const fresh = await tryAs(U.outsider, ORG_CREATE, ["drained-org", spend, await uuidv7()]);
    expect(fresh.error).toMatchObject({ code: "SH429", message: "organization_create: rate_limited" });
  });
});

describe("the template workspace", () => {
  it("copies colour, zone and lateness tolerance; the caller becomes Owner; the template is unchanged", async () => {
    const template = await freshWorkspace();
    await rows(
      "UPDATE app.workspaces SET colour = '#123456', default_tz = 'Africa/Cairo', lateness_tolerance = '30 minutes' WHERE id = $1",
      [template],
    );
    const shape =
      "SELECT colour, default_tz, lateness_tolerance::text AS tolerance FROM app.workspaces WHERE id = $1";
    const before = await rows(shape, [template]);
    const [made] = await commit(asUser(U.orgAdmin), WS_CREATE, [
      OA,
      "copied",
      `copied-${randomUUID().slice(0, 8)}`,
      null,
      null,
      template,
      false,
    ]);
    expect(await rows(shape, [made?.id])).toEqual(before);
    expect(await rows(shape, [template])).toEqual(before);
    const owner = await rows(
      `SELECT r.key FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [made?.id, U.orgAdmin],
    );
    expect(owner).toEqual([{ key: "owner" }]);
  });

  it.each([
    ["another organization's workspace", U.orgOwner, OA, () => WB],
    ["a workspace of the caller's other organization", U.bOwner, OB, () => WA],
    ["an unknown id", U.orgOwner, OA, () => randomUUID()],
  ])("refuses %s like a missing one and copies nothing", async (_label, user, org, template) => {
    const name = `stolen-${randomUUID().slice(0, 8)}`;
    expect(codeOf(await tryAs(user, WS_CREATE, [org, name, name, null, null, template(), false]))).toBe(
      "42501",
    );
    expect(await rows("SELECT id FROM app.workspaces WHERE name = $1", [name])).toEqual([]);
  });

  it("refuses a create with neither a zone nor a template with 22023", async () => {
    expect(
      codeOf(await tryAs(U.orgOwner, WS_CREATE, [OA, "no-zone", "no-zone", null, null, null, false])),
    ).toBe("22023");
  });
});

describe("my_workspaces", () => {
  it("answers archived_at, avatar and the organization type, also for a workspace-only member", async () => {
    const ws = await freshWorkspace();
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    const listed = await commit(
      asUser(U.viewer),
      "SELECT workspace_id, archived_at IS NOT NULL AS archived, avatar, organization_type FROM app.my_workspaces(100, NULL)",
    );
    expect(listed).toContainEqual({
      workspace_id: ws,
      archived: true,
      avatar: null,
      organization_type: "team",
    });
    expect(listed).toContainEqual({
      workspace_id: WA,
      archived: false,
      avatar: null,
      organization_type: "team",
    });
  });
});

const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };
const ledger = (sql: string, params: unknown[] = []) => commit(LEDGER, sql, params, "worker");

async function target(ws: string) {
  const provider = `archive-${randomUUID().slice(0, 8)}`;
  const [channel] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
    [ws, provider],
  );
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
    [ws, U.editor],
  );
  const [variant] = await rows(
    `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at)
     VALUES ($1, $2, $3, 'scheduled', now() - interval '10 seconds') RETURNING id`,
    [ws, post?.id, channel?.id],
  );
  const map = { [provider]: { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 60 } } };
  return { provider, variant: variant?.id as string, map: JSON.stringify(map) };
}
const admit = (map: string) => ledger("SELECT * FROM app.admit_due_targets(100, $1::jsonb)", [map]);
const opsOf = (variant: string) => rows("SELECT state FROM app.operations WHERE variant_id = $1", [variant]);

describe("admission of an archived workspace (no duplicate or late publish)", () => {
  it("makes no operation while archived; after restore within the tolerance exactly one", async () => {
    const ws = await freshWorkspace();
    const t = await target(ws);
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    expect(await admit(t.map)).toEqual([]);
    expect(await opsOf(t.variant)).toEqual([]);
    await commit(asUser(U.owner), UNARCHIVE, [ws]);
    await admit(t.map);
    await admit(t.map);
    expect(await opsOf(t.variant)).toEqual([{ state: "pending" }]);
  });

  it("after restore past the tolerance takes the missed path and sends nothing", async () => {
    const ws = await freshWorkspace();
    await rows("UPDATE app.workspaces SET lateness_tolerance = '5 minutes' WHERE id = $1", [ws]);
    const t = await target(ws);
    await rows("UPDATE app.post_variants SET due_at = now() - interval '10 minutes' WHERE id = $1", [
      t.variant,
    ]);
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    expect(await admit(t.map)).toEqual([]);
    await commit(asUser(U.owner), UNARCHIVE, [ws]);
    await admit(t.map);
    expect(await opsOf(t.variant)).toEqual([{ state: "missed" }]);
  });

  it("an operation admitted before the archive is still claimed and runs to its end", async () => {
    const ws = await freshWorkspace();
    const t = await target(ws);
    const [admitted] = await admit(t.map);
    await commit(asUser(U.owner), ARCHIVE, [ws]);
    const claimed = await ledger("SELECT id FROM app.claim_operations($1, 10, 'w1')", [
      `publish.${t.provider}`,
    ]);
    expect(claimed).toEqual([{ id: admitted?.operation_id }]);
  });
});
