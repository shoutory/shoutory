import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addWorkspaceMember,
  seedChannel,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// Security floor of the channel routes (R532 (0), R533 (B), (D)): who may read and who may change a channel,
// the one 404 for what the caller may not see, the answer allowlist (no credential field ever), and the audit row of
// each state change. The permissions are channels.view (owner, admin, editor) and channels.manage (owner, admin).

type User = { id: string; cookie: string };
let fx: Fixture;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
const MISSING = "019a0000-0000-7000-8000-000000000000";
const ALLOWLIST = [
  "account_kind",
  "actions",
  "avatar",
  "capability_epoch",
  "connection_state",
  "display_name",
  "handle",
  "health",
  "health_checked_at",
  "id",
  "nickname",
  "provider_id",
  "reconnect_deadline",
  "state_reason",
  "token_expires_at",
];

beforeAll(async () => {
  fx = await startFixture();
  const founder = await signedUser(fx, "chan-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `chan-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());

const base = (workspace: string) => `/api/v1/workspaces/${workspace}/channels`;
const call = (who: User, method: string, path: string, body?: Record<string, unknown>) =>
  fx.request(path, { method, headers: { cookie: who.cookie }, ...(body ? { body } : {}) });
const errorOf = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string } };
  return [answer.status, error.code];
};
const rowOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          "SELECT nickname, display_name, connection_state, state_reason FROM app.channels WHERE id = $1",
          [id],
        )
      ).rows[0],
  );
const auditActions = (id: string) =>
  fx.admin(async (client) =>
    (
      await client.query("SELECT action FROM app.audit_logs WHERE resource_id = $1 ORDER BY at", [id])
    ).rows.map((row) => row.action as string),
  );

describe("who may read channels (channels.view)", () => {
  it.each([
    ["owner", 200],
    ["admin", 200],
    ["editor", 200],
    ["approver", 403],
    ["viewer", 403],
  ])("a %s gets %i on the list and on the detail", async (role, status) => {
    const id = await seedChannel(fx, ws);
    const answers = await Promise.all([
      call(user(role), "GET", base(ws)),
      call(user(role), "GET", `${base(ws)}/${id}`),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([status, status]);
  });

  it("a non-member of the workspace gets the identical 404 as for a missing workspace, on list and detail", async () => {
    const id = await seedChannel(fx, ws);
    for (const path of [base(ws), `${base(ws)}/${id}`]) {
      const real = await call(user("outsider"), "GET", path);
      const missing = await call(user("outsider"), "GET", path.replace(ws, MISSING));
      expect(real.status).toBe(404);
      expect(await errorOf(real)).toEqual(await errorOf(missing));
    }
  });

  it("a channel of another workspace answers 404 exactly like a missing channel id", async () => {
    const foreign = await seedChannel(fx, other);
    const viaMine = await call(user("admin"), "GET", `${base(ws)}/${foreign}`);
    const missing = await call(user("admin"), "GET", `${base(ws)}/${MISSING}`);
    expect(viaMine.status).toBe(404);
    expect(await errorOf(viaMine)).toEqual(await errorOf(missing));
  });
});

describe("what the channel list and detail answer", () => {
  it("the list holds this workspace's channels only, and every row carries exactly the allowlisted fields", async () => {
    const mine = await seedChannel(fx, ws);
    const foreign = await seedChannel(fx, other);
    const body = (await (await call(user("admin"), "GET", base(ws))).json()) as {
      data: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    const ids = body.data.map((row) => row.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(foreign);
    for (const row of body.data) expect(Object.keys(row).sort()).toEqual(ALLOWLIST);
    // This app has no provider registry and no check wiring: no row has an action and the list offers no connect.
    for (const row of body.data) expect(row.actions).toEqual([]);
    expect(body.meta.actions).toEqual([]);
    const detail = (await (await call(user("admin"), "GET", `${base(ws)}/${mine}`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(detail.data).sort()).toEqual(ALLOWLIST);
  });

  it("the list is cursor-paged: limit 1 returns one row and a cursor that reaches the next page", async () => {
    await seedChannel(fx, ws);
    await seedChannel(fx, ws);
    const first = (await (await call(user("admin"), "GET", `${base(ws)}?limit=1`)).json()) as {
      data: Array<{ id: string }>;
      meta: { next_cursor: string | null };
    };
    expect(first.data).toHaveLength(1);
    expect(first.meta.next_cursor).toEqual(expect.any(String));
    const second = (await (
      await call(user("admin"), "GET", `${base(ws)}?limit=1&cursor=${first.meta.next_cursor}`)
    ).json()) as { data: Array<{ id: string }> };
    expect(second.data).toHaveLength(1);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  });
});

describe("who may change channels (channels.manage)", () => {
  it.each(["editor", "approver", "viewer"])(
    "a %s gets 403 on rename, disable and enable, and the channel and its audit stay as they were",
    async (role) => {
      const live = await seedChannel(fx, ws);
      const off = await seedChannel(fx, ws, "disabled");
      const answers = await Promise.all([
        call(user(role), "PATCH", `${base(ws)}/${live}`, { nickname: "Mine" }),
        call(user(role), "POST", `${base(ws)}/${live}/disable`),
        call(user(role), "POST", `${base(ws)}/${off}/enable`),
      ]);
      expect(await Promise.all(answers.map(errorOf))).toEqual(Array(3).fill([403, "forbidden"]));
      expect(await rowOf(live)).toMatchObject({ nickname: null, connection_state: "connected" });
      expect((await rowOf(off)).connection_state).toBe("disabled");
      expect([...(await auditActions(live)), ...(await auditActions(off))]).toEqual([]);
    },
  );

  it("a non-member and a member of another workspace get 404 on every change, even with a real channel id", async () => {
    const id = await seedChannel(fx, ws);
    const calls = [
      ["PATCH", `${base(ws)}/${id}`, { nickname: "x" }],
      ["POST", `${base(ws)}/${id}/disable`, undefined],
      ["POST", `${base(ws)}/${id}/enable`, undefined],
    ] as const;
    for (const who of ["outsider", "foreign"]) {
      for (const [method, path, body] of calls) {
        expect((await call(user(who), method, path, body as Record<string, unknown>)).status).toBe(404);
      }
    }
    expect((await rowOf(id)).connection_state).toBe("connected");
  });

  it("a channel of another workspace cannot be changed through this workspace's path", async () => {
    const foreign = await seedChannel(fx, other);
    const answers = await Promise.all([
      call(user("admin"), "PATCH", `${base(ws)}/${foreign}`, { nickname: "x" }),
      call(user("admin"), "POST", `${base(ws)}/${foreign}/disable`),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([404, 404]);
    expect(await rowOf(foreign)).toMatchObject({ nickname: null, connection_state: "connected" });
  });
});

describe("rename, disable and enable", () => {
  it("rename sets the nickname only: display_name stays the provider's, and null clears it", async () => {
    const id = await seedChannel(fx, ws);
    const before = await rowOf(id);
    const set = await call(user("admin"), "PATCH", `${base(ws)}/${id}`, { nickname: "Brand page" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { data: { nickname: string } }).data.nickname).toBe("Brand page");
    expect(await rowOf(id)).toMatchObject({ nickname: "Brand page", display_name: before.display_name });
    const cleared = await call(user("owner"), "PATCH", `${base(ws)}/${id}`, { nickname: null });
    expect(cleared.status).toBe(200);
    expect((await rowOf(id)).nickname).toBeNull();
  });

  it.each([
    ["an unknown field", { nickname: "x", connection_state: "connected" }],
    ["display_name", { display_name: "forged" }],
    ["an empty body", {}],
    ["a number", { nickname: 7 }],
    ["an oversized nickname", { nickname: "n".repeat(201) }],
  ])("rename refuses %s with 400 validation_failed and changes nothing", async (_what, body) => {
    const id = await seedChannel(fx, ws);
    const answer = await call(user("admin"), "PATCH", `${base(ws)}/${id}`, body);
    expect(await errorOf(answer)).toEqual([400, "validation_failed"]);
    expect(await rowOf(id)).toMatchObject({ nickname: null, connection_state: "connected" });
  });
});

describe("disable and enable", () => {
  it("disable answers the channel as disabled with admin_disabled, audits it, and a second disable is 409", async () => {
    const id = await seedChannel(fx, ws);
    const first = await call(user("admin"), "POST", `${base(ws)}/${id}/disable`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      id,
      connection_state: "disabled",
      state_reason: "admin_disabled",
    });
    expect(await auditActions(id)).toEqual(["channel.disabled"]);
    expect(await errorOf(await call(user("admin"), "POST", `${base(ws)}/${id}/disable`))).toEqual([
      409,
      "conflict",
    ]);
    expect(await auditActions(id)).toEqual(["channel.disabled"]);
  });

  it("enable moves a disabled channel to needs_reconnect, never connected, audits it, and 409s on any other state", async () => {
    const off = await seedChannel(fx, ws, "disabled");
    const enabled = await call(user("owner"), "POST", `${base(ws)}/${off}/enable`);
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { data: { connection_state: string } }).data.connection_state).toBe(
      "needs_reconnect",
    );
    expect(await auditActions(off)).toEqual(["channel.enabled"]);
    const live = await seedChannel(fx, ws, "connected");
    expect(await errorOf(await call(user("owner"), "POST", `${base(ws)}/${live}/enable`))).toEqual([
      409,
      "conflict",
    ]);
    expect((await rowOf(live)).connection_state).toBe("connected");
  });
});
