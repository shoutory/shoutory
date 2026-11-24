import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, seedMembers, U, WA, WB } from "../support/members-seed.js";

const env = readTestEnv();

// The seeded workspace is that of the members fixture: U.owner and U.admin manage channels; U.editor, U.approver
// and U.viewer do not; U.outsider is no member.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);

async function plant(workspace: string, state: string): Promise<string> {
  const id = randomUUID();
  await admin((client) =>
    client.query(
      `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
         connection_state, state_reason)
       VALUES ($1::uuid, $2, 'fixture-oauth', 'profile', $1::text, 'definer channel', $3::text,
         CASE WHEN $3::text = 'disabled' THEN 'admin_disabled' END)`,
      [id, workspace, state],
    ),
  );
  return id;
}
const stateOf = (id: string) =>
  admin(
    async (client) =>
      (await client.query("SELECT connection_state, state_reason FROM app.channels WHERE id = $1", [id]))
        .rows[0],
  );
const auditOf = (id: string) =>
  admin(
    async (client) =>
      (
        await client.query(
          "SELECT action, resource_kind, actor_kind, actor_ref FROM app.audit_logs WHERE resource_id = $1",
          [id],
        )
      ).rows,
  );

const DISABLE = "SELECT app.channel_disable($1, $2, 'req-channel', NULL)";
const ENABLE = "SELECT app.channel_enable($1, $2, 'req-channel', NULL)";

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

describe("channel_disable and channel_enable", () => {
  it.each(["connected", "needs_reconnect", "disconnected", "revoked_by_provider"])(
    "an admin disables a %s channel: state disabled, reason admin_disabled, one audit row",
    async (state) => {
      const id = await plant(WA, state);
      await commitAs(db.pool("app"), U.admin, DISABLE, [WA, id]);
      expect(await stateOf(id)).toEqual({ connection_state: "disabled", state_reason: "admin_disabled" });
      expect(await auditOf(id)).toEqual([
        { action: "channel.disabled", resource_kind: "channel", actor_kind: "user", actor_ref: U.admin },
      ]);
    },
  );

  it("disabling a disabled channel is refused with SH409 and leaves one audit row, not two", async () => {
    const id = await plant(WA, "connected");
    await commitAs(db.pool("app"), U.owner, DISABLE, [WA, id]);
    const again = await attempt(db.pool("app"), asUser(U.owner), DISABLE, [WA, id]);
    expect(again.error).toMatchObject({ code: "SH409" });
    expect(await auditOf(id)).toHaveLength(1);
  });

  it("enable restores a disabled channel to needs_reconnect, never connected, and audits it", async () => {
    const id = await plant(WA, "disabled");
    await commitAs(db.pool("app"), U.admin, ENABLE, [WA, id]);
    const after = await stateOf(id);
    expect(after.connection_state).toBe("needs_reconnect");
    expect(after.state_reason).not.toBe("admin_disabled");
    expect((await auditOf(id)).map((row) => row.action)).toEqual(["channel.enabled"]);
  });
});

describe("channel_enable and who may call the definers", () => {
  it.each(["connected", "needs_reconnect", "disconnected", "revoked_by_provider"])(
    "enabling a %s channel is refused with SH409 and changes nothing",
    async (state) => {
      const id = await plant(WA, state);
      const run = await attempt(db.pool("app"), asUser(U.admin), ENABLE, [WA, id]);
      expect(run.error).toMatchObject({ code: "SH409" });
      expect((await stateOf(id)).connection_state).toBe(state);
      expect(await auditOf(id)).toEqual([]);
    },
  );

  it.each(["editor", "approver", "viewer"] as const)(
    "a %s lacks channels.manage: SH403 on both definers, state and audit untouched",
    async (role) => {
      const live = await plant(WA, "connected");
      const off = await plant(WA, "disabled");
      const calls = [
        await attempt(db.pool("app"), asUser(U[role]), DISABLE, [WA, live]),
        await attempt(db.pool("app"), asUser(U[role]), ENABLE, [WA, off]),
      ];
      expect(calls.map((run) => (run.error as { code?: string }).code)).toEqual(["SH403", "SH403"]);
      expect((await stateOf(live)).connection_state).toBe("connected");
      expect((await stateOf(off)).connection_state).toBe("disabled");
      expect([...(await auditOf(live)), ...(await auditOf(off))]).toEqual([]);
    },
  );

  // A caller outside the workspace, a channel of another workspace and a missing channel all get the one answer.
  it("an outsider, a foreign channel and a missing channel are all refused with the same 42501 message", async () => {
    const mine = await plant(WA, "connected");
    const foreign = await plant(WB, "connected");
    const runs = await Promise.all([
      attempt(db.pool("app"), asUser(U.outsider), DISABLE, [WA, mine]),
      attempt(db.pool("app"), asUser(U.admin), DISABLE, [WA, foreign]),
      attempt(db.pool("app"), asUser(U.admin), DISABLE, [WA, randomUUID()]),
      attempt(db.pool("app"), asUser(U.bOwner), DISABLE, [WA, mine]),
    ]);
    const errors = runs.map((run) => run.error as { code?: string; message?: string });
    expect(errors.map((error) => error.code)).toEqual(Array(4).fill("42501"));
    expect(new Set(errors.map((error) => error.message)).size).toBe(1);
    expect((await stateOf(mine)).connection_state).toBe("connected");
    expect((await stateOf(foreign)).connection_state).toBe("connected");
  });
});

describe("what the app role may write to a channel", () => {
  const ctx = () => ({ ...asUser(U.admin), workspaceIds: [WA], writeWorkspaceId: WA });

  // Every other column, the insert and the delete are guarded by the runtime-grants rows and the isolation matrix.
  it("sets the nickname of its own workspace's channel", async () => {
    const id = await plant(WA, "connected");
    const run = await attempt(
      db.pool("app"),
      ctx(),
      "UPDATE app.channels SET nickname = 'Main' WHERE id = $1",
      [id],
    );
    expect(run.error).toBeUndefined();
  });
});
