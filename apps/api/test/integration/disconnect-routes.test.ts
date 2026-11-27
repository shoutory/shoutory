import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { withSystem } from "@shoutory/db/context/system";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaks } from "../support/canary.js";
import { connectChannel, tokenOfAccount } from "../support/ledger-credentials.js";
import { seedFrozenVersion } from "../support/ledger-seed.js";
import { probeWhileHeld, rowLock } from "../support/lock-probe.js";
import {
  addWorkspaceMember,
  seedOrganization,
  seedWorkspace,
  signedUser,
  unique,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// Disconnect keeps every row and refuses while work is in flight. Transaction 1 takes the channel advisory lock, holds
// the waiting operations and moves the credential to `revoking`; the revoke call runs between the two transactions;
// transaction 2 overwrites the secret bytes.
type User = { id: string; cookie: string };
const manifest = manifestSchema.parse({
  ...fixtureOAuthManifest,
  providerDefault: { max_length: 280, sensitive: false, tag: "x" },
});
const PEPPER = new SealedSecret("ledger-test-pepper-0123456789abcdef");

type Seen = {
  channel: string;
  credential: string;
  secretBytes: number;
  openTransactions: number;
  locked: boolean;
};
const during: Seen[] = [];
let revokeBehaviour: "ok" | "fail" = "ok";
let revokeCalls = 0;
let watched = "";

let fx: Fixture;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
const SEATS: [string, string][] = [
  ["owner", "owner"],
  ["admin", "admin"],
  ["editor", "editor"],
  ["approver", "approver"],
  ["viewer", "viewer"],
];

async function observeDuringRevoke(): Promise<void> {
  revokeCalls += 1;
  const found = await fx.admin(async (client) => {
    const channel = await client.query("SELECT connection_state FROM app.channels WHERE id = $1", [watched]);
    const credential = await client.query(
      "SELECT state, length(ciphertext) AS bytes FROM app.channel_credentials WHERE channel_id = $1 ORDER BY generation DESC",
      [watched],
    );
    const open = await client.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
         AND usename = 'shoutory_app' AND state LIKE 'idle in transaction%'`,
    );
    await client.query("BEGIN");
    let locked = false;
    try {
      await client.query("SELECT 1 FROM app.channels WHERE id = $1 FOR UPDATE NOWAIT", [watched]);
    } catch (error) {
      locked = (error as { code?: string }).code === "55P03";
    }
    await client.query("ROLLBACK");
    return {
      channel: channel.rows[0].connection_state,
      credential: credential.rows[0].state,
      secretBytes: credential.rows[0].bytes,
      openTransactions: open.rows[0].n,
      locked,
    } satisfies Seen;
  });
  during.push(found);
  if (revokeBehaviour === "fail") throw new Error("the provider refused the revoke");
}

beforeAll(async () => {
  const base = createFixtureAdapter({ baseUrl: "http://127.0.0.1:1", clientId: "c" });
  fx = await startFixture({
    channels: {
      providers: {
        fixture_oauth: { adapter: { ...base, revoke: observeDuringRevoke } as typeof base, manifest },
        fixture_plain: { adapter: base, manifest: { ...manifest, id: "fixture_plain" } },
      },
      fetch,
      pepper: PEPPER,
    },
  });
  const founder = await signedUser(fx, "disc-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const [name, role] of SEATS) {
    users[name] = await signedUser(fx, `disc-${name}`);
    await addWorkspaceMember(fx, ws, user(name).id, role);
  }
  users.foreign = await signedUser(fx, "disc-foreign");
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());

const path = (workspace: string, channel: string) =>
  `/api/v1/workspaces/${workspace}/channels/${channel}/disconnect`;
let keyNo = 0;
const disconnect = (who: User, workspace: string, channel: string, headers: Record<string, string> = {}) =>
  fx.request(path(workspace, channel), {
    method: "POST",
    headers: { cookie: who.cookie, "idempotency-key": `disc-key-${++keyNo}`, ...headers },
    body: {},
  });
const answerOf = async (response: Response) =>
  (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: { reason?: string; blocking?: { kind: string; id: string }[] } };
  };

interface Planted {
  channel: string;
  account: string;
  token: string;
  workspace: string;
  provider: string;
}
async function plantChannel(workspace = ws, provider = "fixture_oauth"): Promise<Planted> {
  const account = unique("disc-account");
  const channel = await connectChannel(fx.db.pool("worker"), { workspace, provider, account });
  watched = channel;
  return { channel, account, token: tokenOfAccount(account), workspace, provider };
}

async function plantOp(c: Planted, state: string, effect = "none"): Promise<string> {
  return fx.admin(async (client) => {
    const post = await client.query(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [c.workspace, user("editor").id],
    );
    const frozen = await seedFrozenVersion(client, c.workspace, post.rows[0].id, c.channel);
    const variant = await client.query(
      `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, due_at)
       VALUES ($1, $2, $3, 'in_progress', $4, now() - interval '1 minute') RETURNING id`,
      [c.workspace, post.rows[0].id, c.channel, frozen],
    );
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
       VALUES ($1, $2, $3, $4, 'publish.' || $4, 'publish', $5, $6, 'S', now() - interval '2 minutes',
         now() - interval '1 minute', now() + interval '2 hours', $7, $8, decode(repeat('ab', 32), 'hex'), $9, 60, 1)
       RETURNING id`,
      [
        c.workspace,
        variant.rows[0].id,
        c.channel,
        c.provider,
        state,
        effect,
        `disc-${randomUUID()}`,
        frozen,
        user("editor").id,
      ],
    );
    await client.query("COMMIT");
    return op.rows[0].id as string;
  });
}

const channelRow = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          "SELECT connection_state, disconnected_at, reconnect_deadline FROM app.channels WHERE id = $1",
          [id],
        )
      ).rows[0],
  );
const credentialRows = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT state, length(ciphertext) AS ciphertext, length(iv) AS iv, length(auth_tag) AS auth_tag,
             length(wrapped_dek) AS wrapped_dek FROM app.channel_credentials WHERE channel_id = $1`,
          [id],
        )
      ).rows,
  );
const opState = (id: string) =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT state FROM app.operations WHERE id = $1", [id])).rows[0].state,
  );
const rowCounts = (workspace: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT (SELECT count(*) FROM app.posts WHERE workspace_id = $1)::int AS posts,
             (SELECT count(*) FROM app.post_variants WHERE workspace_id = $1)::int AS variants,
             (SELECT count(*) FROM app.operations WHERE workspace_id = $1)::int AS operations,
             (SELECT count(*) FROM app.post_versions WHERE workspace_id = $1)::int AS versions`,
          [workspace],
        )
      ).rows[0],
  );

describe("who may disconnect a channel (channels.manage, with a fresh step-up)", () => {
  it.each([
    ["viewer", 403],
    ["approver", 403],
    ["editor", 403],
    ["admin", 200],
    ["owner", 200],
  ] as const)("%s answers %i", async (seat, status) => {
    const c = await plantChannel();
    const answered = await disconnect(user(seat), ws, c.channel);
    expect(answered.status).toBe(status);
    expect((await channelRow(c.channel)).connection_state).toBe(
      status === 200 ? "disconnected" : "connected",
    );
    if (status !== 200) expect((await credentialRows(c.channel))[0]?.state).toBe("active");
  });

  it.each([null, "11 minutes"])(
    "a stale step-up (%s) is 403 step_up_required and nothing changes",
    async (interval) => {
      const c = await plantChannel();
      const who = await signedUser(fx, "disc-stale");
      await addWorkspaceMember(fx, ws, who.id, "admin");
      await fx.admin((client) =>
        interval === null
          ? client.query("DELETE FROM app.session_step_ups WHERE user_id = $1", [who.id])
          : client.query(
              "UPDATE app.session_step_ups SET at = clock_timestamp() - $2::interval WHERE user_id = $1",
              [who.id, interval],
            ),
      );
      const refused = await answerOf(await disconnect(who, ws, c.channel));
      expect(refused.error?.code).toBe("step_up_required");
      expect((await channelRow(c.channel)).connection_state).toBe("connected");
      expect((await credentialRows(c.channel))[0]?.state).toBe("active");
    },
  );

  it("a missing Idempotency-Key is 400 validation_failed idempotency_key_required", async () => {
    const c = await plantChannel();
    const refused = await fx.request(path(ws, c.channel), {
      method: "POST",
      headers: { cookie: user("owner").cookie },
      body: {},
    });
    const body = await answerOf(refused);
    expect([refused.status, body.error?.code, body.error?.details?.reason]).toEqual([
      400,
      "validation_failed",
      "idempotency_key_required",
    ]);
    expect((await channelRow(c.channel)).connection_state).toBe("connected");
  });
});

describe("a channel of another workspace", () => {
  it("answers 404 like a missing one, and nothing changes", async () => {
    const [theirs, mine] = [await plantChannel(other), await plantChannel()];
    const missing = await disconnect(user("admin"), ws, randomUUID());
    const through = await disconnect(user("admin"), ws, theirs.channel);
    const reverse = await disconnect(user("foreign"), other, mine.channel);
    expect([missing.status, through.status, reverse.status]).toEqual([404, 404, 404]);
    for (const c of [theirs, mine]) {
      expect((await channelRow(c.channel)).connection_state).toBe("connected");
      expect((await credentialRows(c.channel))[0]?.state).toBe("active");
    }
    expect((await disconnect(user("foreign"), other, theirs.channel)).status).toBe(200);
  });
});

describe("disconnect with work in flight", () => {
  it.each([
    "claimed",
    "dispatching",
    "provider_accepted",
    "unknown_external_state",
    "reconciling",
    "needs_human",
    "unverified",
  ])("%s refuses with 409 channel_busy and a blocking list, and changes nothing", async (state) => {
    const c = await plantChannel();
    const op = await plantOp(c, state, "possible");
    const refused = await disconnect(user("owner"), ws, c.channel);
    const body = await answerOf(refused);
    expect([refused.status, body.error?.code, body.error?.details?.reason]).toEqual([
      409,
      "conflict",
      "channel_busy",
    ]);
    expect(body.error?.details?.blocking).toEqual([{ kind: "operation", id: op }]);
    expect((await channelRow(c.channel)).connection_state).toBe("connected");
    expect((await credentialRows(c.channel))[0]?.state).toBe("active");
    expect(await opState(op)).toBe(state);
  });
});

describe("what disconnect does", () => {
  it("deletes nothing, holds the waiting operations and sets the 30-day deadline", async () => {
    const c = await plantChannel();
    const waiting = await Promise.all(["pending", "retry_wait", "paused"].map((state) => plantOp(c, state)));
    const done = await plantOp(c, "published", "confirmed");
    const before = await rowCounts(ws);
    const answered = await disconnect(user("admin"), ws, c.channel);
    expect(answered.status).toBe(200);
    expect(await rowCounts(ws)).toEqual(before);
    expect(await Promise.all(waiting.map(opState))).toEqual(Array(3).fill("blocked_reconnect"));
    expect(await opState(done)).toBe("published");
    const row = await channelRow(c.channel);
    expect(row.connection_state).toBe("disconnected");
    const days =
      (new Date(row.reconnect_deadline).getTime() - new Date(row.disconnected_at).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 1);
  });

  it("answers a second disconnect of the same channel without a second revoke", async () => {
    const c = await plantChannel();
    revokeCalls = 0;
    const [first, second] = await Promise.all([
      disconnect(user("owner"), ws, c.channel),
      disconnect(user("admin"), ws, c.channel),
    ]);
    expect([first.status, second.status].filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect([first.status, second.status].every((status) => status < 500)).toBe(true);
    expect(revokeCalls).toBe(1);
  });
});

describe("the credential after disconnect", () => {
  it("has no secret bytes left, and the token is in no answer, log or row in any of its forms", async () => {
    const c = await plantChannel();
    const answered = await disconnect(user("owner"), ws, c.channel);
    expect(answered.status).toBe(200);
    const rows = await credentialRows(c.channel);
    expect(rows).toEqual([{ state: "destroyed", ciphertext: 0, iv: 0, auth_tag: 0, wrapped_dek: 0 }]);
    const stored = await fx.admin(async (client) =>
      JSON.stringify(
        (await client.query("SELECT * FROM app.channel_credentials WHERE channel_id = $1", [c.channel])).rows,
      ),
    );
    expect(leaks([await answered.text(), stored, ...fx.logged].join("\n"), [c.token])).toEqual([]);
  });

  it("is destroyed with no revoke for a provider whose adapter has none, and the answer says so", async () => {
    const c = await plantChannel(ws, "fixture_plain");
    const body = await answerOf(await disconnect(user("owner"), ws, c.channel));
    expect(body.data?.revoke).toBe("unsupported");
    expect((await credentialRows(c.channel))[0]?.state).toBe("destroyed");
  });
});

describe("the revoke call", () => {
  it("runs between the two transactions: committed disconnect, revoking credential, no open transaction, no lock", async () => {
    const c = await plantChannel();
    during.length = 0;
    revokeBehaviour = "ok";
    const body = await answerOf(await disconnect(user("owner"), ws, c.channel));
    const seen = during[0];
    expect(seen).toEqual({
      channel: "disconnected",
      credential: "revoking",
      secretBytes: expect.any(Number),
      openTransactions: 0,
      locked: false,
    });
    expect(seen?.secretBytes).toBeGreaterThan(0);
    expect(body.data?.revoke).toBe("done");
    expect((await credentialRows(c.channel))[0]?.state).toBe("destroyed");
  });

  it("failing is told to the user and never blocks the destroy", async () => {
    const c = await plantChannel();
    revokeBehaviour = "fail";
    try {
      const answered = await disconnect(user("owner"), ws, c.channel);
      const body = await answerOf(answered);
      expect(answered.status).toBe(200);
      expect(body.data?.revoke).toBe("failed");
      expect((await channelRow(c.channel)).connection_state).toBe("disconnected");
      expect(await credentialRows(c.channel)).toEqual([
        { state: "destroyed", ciphertext: 0, iv: 0, auth_tag: 0, wrapped_dek: 0 },
      ]);
    } finally {
      revokeBehaviour = "ok";
    }
  });
});

describe("disconnect racing a claim", () => {
  const claim = () =>
    withSystem(fx.db.pool("worker"), "ledger", async (tx) =>
      (
        await tx.query("SELECT id FROM app.claim_operations('publish.fixture_oauth', 5, 'race-owner')")
      ).rows.map((row) => row.id),
    );

  it("either the claim came first and the disconnect is refused, or the claim saw the disconnect and took nothing", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round++) {
      const c = await plantChannel();
      const op = await plantOp(c, "pending");
      const [answered, claimed] = await Promise.all([disconnect(user("owner"), ws, c.channel), claim()]);
      const took = (claimed as string[]).includes(op);
      outcomes.add(took ? "claim first" : "disconnect first");
      if (took) {
        expect(answered.status).toBe(409);
        expect((await channelRow(c.channel)).connection_state).toBe("connected");
        expect(await opState(op)).toBe("claimed");
      } else {
        expect(answered.status).toBe(200);
        expect(await opState(op)).toBe("blocked_reconnect");
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});

describe("lock order: the channel advisory lock comes before any row", () => {
  it("disconnect waits on the held channel lock holding no channel or operation row, then completes", async () => {
    const c = await plantChannel();
    const op = await plantOp(c, "pending");
    const outcome = await probeWhileHeld(
      fx.admin,
      { sql: "SELECT pg_advisory_xact_lock(2, hashtext($1))", params: [c.channel] },
      () => disconnect(user("owner"), ws, c.channel),
      [rowLock("channels", c.channel), rowLock("operations", op)],
    );
    expect(outcome.free).toEqual([true, true]);
    expect(outcome.response.status).toBe(200);
  });
});
