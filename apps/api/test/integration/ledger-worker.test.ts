import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@shoutory/db/context";
import { createAppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { startFixtureSimulator } from "@shoutory/testkit/fixture-provider/simulator";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { startHeartbeat } from "../../src/jobs/ledger/heartbeat.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { connectChannel, ledgerKeys } from "../support/ledger-credentials.js";
import { seedFrozenVersion, seedWorkspace } from "../support/ledger-seed.js";

const env = readTestEnv();

// Security floor of the worker turn: a lost lease stops every write of its holder, a closing worker claims nothing and
// hands back what it took, and the state of the channel and of the target is read again after the claim and before any
// work. A turn that passes every check goes on to dispatch to the fixture provider and ends `dispatched`. The module
// names, argument lists, result kinds and column names are the contract the runtime must meet.
let db: TestDatabase;
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (a) => (await a.query(sql, params)).rows as Record<string, unknown>[]);

let ws: string;
// The turns dispatch to the fixture provider: its adapter on its simulator, over the plain `fetch`.
// and open the credential of each claimed channel with the key ring the test stored them under.
let wiring: Pick<Parameters<typeof runTurn>[0], "adapters" | "fetchFor"> & { keys: typeof ledgerKeys };
let simulator: Awaited<ReturnType<typeof startFixtureSimulator>>;
beforeAll(async () => {
  simulator = await startFixtureSimulator();
  wiring = {
    adapters: { fixture: createFixtureAdapter({ baseUrl: simulator.url }) },
    fetchFor: () => fetch,
    keys: ledgerKeys,
  };
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  ws = randomUUID();
  const [user, org] = [randomUUID(), randomUUID()];
  await admin(async (a) => {
    await a.query("BEGIN");
    await a.query('INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [
      user,
      "ledger-worker",
      `${user}@example.test`,
    ]);
    await a.query(
      "INSERT INTO app.organizations (id, name, slug, type) VALUES ($1, 'lw', 'lw-org', 'team')",
      [org],
    );
    await a.query(
      "INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, 'owner')",
      [org, user],
    );
    await a.query(
      "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, 'lw', 'lw-ws')",
      [ws, org],
    );
    await a.query(
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
       VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner'))`,
      [ws, user],
    );
    await a.query("COMMIT");
  });
});
afterAll(async () => {
  await simulator.close();
  await db.drop();
});

const registry = createRegistry([fixtureManifest]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves when the signal aborts, rejects when it does not within `ms`. */
const aborted = (signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => reject(new Error("the signal did not abort")), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

interface Scenario {
  channelState?: string;
  deleted?: boolean;
  postStatus?: string;
  scheduleState?: string;
  /** The state the operation is planted in; `pending` is due now and can be claimed. */
  state?: string;
  queue?: string;
  /** The provider account of the channel, and the workspace it is in; both a fresh one when absent. */
  account?: string;
  workspace?: string;
  extra?: Record<string, unknown>;
}
interface Planted {
  id: string;
  queue: string;
  account: string;
}
// A channel, a post with one variant and an operation on them, as a claim or an admission would leave them.
async function plant(o: Scenario = {}): Promise<Planted> {
  const account = o.account ?? `lw-${randomUUID().slice(0, 8)}`;
  const home = o.workspace ?? ws;
  const queue = o.queue ?? `publish.lw-${randomUUID().slice(0, 8)}`;
  // Connected through the credential service, so the channel holds a credential; a state other than connected is then set.
  const channel = {
    id: await connectChannel(db.pool("worker"), { workspace: home, provider: "fixture", account }),
  };
  if (o.channelState !== undefined && o.channelState !== "connected") {
    await rows("UPDATE app.channels SET connection_state = $2 WHERE id = $1", [channel.id, o.channelState]);
  }
  const [post] = await rows(
    `INSERT INTO app.posts (workspace_id, author_kind, author_id, status, deleted_at)
     VALUES ($1, 'user', $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
    [home, randomUUID(), o.postStatus ?? "scheduled", o.deleted ?? false],
  );
  const [variant] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, $4) RETURNING id",
    [home, post?.id, channel?.id, o.scheduleState ?? "in_progress"],
  );
  const frozen = await admin((a) => seedFrozenVersion(a, home, String(post?.id), String(channel?.id)));
  const given: Record<string, unknown> = {
    frozen_version_id: frozen,
    frozen_snapshot_hash: Buffer.alloc(32, 0xab),
    workspace_id: home,
    variant_id: variant?.id,
    channel_id: channel?.id,
    provider_id: "fixture",
    queue,
    kind: "publish",
    state: o.state ?? "pending",
    last_actor: "S",
    due_at: new Date(Date.now() - 120_000),
    next_attempt_at: new Date(Date.now() - 60_000),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `lw-${randomUUID()}`,
    requested_by: randomUUID(),
    lease_seconds: 60,
    fencing_token: 1,
    ...o.extra,
  };
  const names = Object.keys(given);
  const id = await admin(async (a) => {
    await a.query("BEGIN");
    await a.query("SET LOCAL session_replication_role = replica");
    const made = await a.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(given),
    );
    await a.query("COMMIT");
    return made.rows[0].id as string;
  });
  return { id, queue, account };
}
const opOf = async (id: string) =>
  (
    await rows(
      `SELECT state, reason_code, effect, fencing_token::int AS token, lease_owner, heartbeat_at, lease_expires_at,
         next_attempt_at
       FROM app.operations WHERE id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;
const attempts = async (id: string) =>
  Number(
    (await rows("SELECT count(*) AS n FROM app.operation_attempts WHERE operation_id = $1", [id]))[0]?.n,
  );

const start = (id: string, extra: Partial<Parameters<typeof startHeartbeat>[0]> = {}) =>
  startHeartbeat({
    pool: db.pool("worker"),
    logger,
    workspaceId: ws,
    id,
    token: 3,
    owner: "owner-a",
    leaseSeconds: 1,
    ...extra,
  });
const claimed = (extra: Record<string, unknown> = {}) =>
  plant({
    state: "claimed",
    extra: {
      fencing_token: 3,
      lease_owner: "owner-a",
      lease_expires_at: new Date(Date.now() + 60_000),
      heartbeat_at: new Date(Date.now() - 60_000),
      ...extra,
    },
  });

// The token moves on as a poll claim moves it, by one, so the holder of the old token no longer holds the lease.
const moveToken = (id: string) =>
  admin(async (a) => {
    await a.query("BEGIN");
    await a.query("SELECT set_config('app.job_purpose', 'claim_polls', true)");
    await a.query("UPDATE app.operations SET fencing_token = fencing_token + 1 WHERE id = $1", [id]);
    await a.query("COMMIT");
  });

describe("the heartbeat of a lease", () => {
  it("a live heartbeat keeps beating for its owner and token, and a lost one aborts its signal and ends all writes", async () => {
    // fails first because: no heartbeat, or one that goes on writing after the token moved on
    const live = await claimed();
    const kept = start(live.id);
    try {
      await sleep(900);
      expect(kept.signal.aborted).toBe(false);
      expect(new Date((await opOf(live.id)).heartbeat_at as string).getTime()).toBeGreaterThan(
        Date.now() - 5_000,
      );
    } finally {
      await kept.stop();
    }
    const lost = await claimed();
    await moveToken(lost.id);
    const stale = start(lost.id);
    try {
      await aborted(stale.signal, 3_000);
      const after = await opOf(lost.id);
      await sleep(800);
      expect(await opOf(lost.id)).toEqual(after);
    } finally {
      await stale.stop();
    }
    // The next fenced write of the holder of token 3 finds no row.
    const write = await withTenant(
      db.pool("worker"),
      { principalKind: "job", jobPurpose: "ledger", workspaceIds: [ws] },
      (tx) =>
        tx.query("SELECT * FROM app.operation_transition($1, $2, 3, 'claimed', 'processing', 'W', '{}')", [
          ws,
          lost.id,
        ]),
    );
    expect(write.rows[0]).toMatchObject({ outcome: "lost_lease" });
  });
});

describe("a heartbeat that cannot reach the database", () => {
  it("a database error is retried within the lease and then aborts the signal", async () => {
    // fails first because: the heartbeat gives up at the first error, or goes on past the end of its lease
    const dead = createAppPool("postgres://nobody:none@127.0.0.1:1/none", () => undefined);
    const began = Date.now();
    const beating = startHeartbeat({
      pool: dead,
      logger,
      workspaceId: ws,
      id: randomUUID(),
      token: 1,
      owner: "owner-a",
      leaseSeconds: 1,
    });
    try {
      await aborted(beating.signal, 4_000);
      expect(Date.now() - began).toBeGreaterThanOrEqual(800);
    } finally {
      await beating.stop();
      await dead.end();
    }
  });
});

const bucketOf = (account: string, name = "posts") =>
  createHash("sha256").update(["fixture", name, "account", account].join("\0")).digest("hex");
const turn = (queue: string, closing: AbortSignal) =>
  runTurn({ pool: db.pool("worker"), logger, registry, ...wiring, queue, owner: "owner-w", closing });
/** Waits until a statement of the bucket definer is parked on a row lock. */
async function untilParked(): Promise<void> {
  for (let tries = 0; tries < 160; tries++) {
    const parked = await rows(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%bucket_take_scoped%'`,
    );
    if (parked.length) return;
    await sleep(25);
  }
}

describe("a heartbeat that hangs", () => {
  it("aborts its signal before its lease ends, and stop() does not wait for the hung beat", async () => {
    // fails first because: the signal waits for the database to answer, so a worker whose lease ended goes on working
    const hung = await claimed();
    await withAdminClient(env, db.name, async (holder) => {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE app.operations IN ACCESS EXCLUSIVE MODE");
      const began = Date.now();
      const beating = start(hung.id);
      try {
        await aborted(beating.signal, 3_000);
        expect(Date.now() - began).toBeLessThan(1_300);
        const stopping = Date.now();
        await beating.stop();
        expect(Date.now() - stopping).toBeLessThan(600);
      } finally {
        await holder.query("COMMIT");
      }
    });
  });
});

describe("a lease lost in the middle of a turn", () => {
  it("ends the turn lost and writes nothing once the heartbeat says so", async () => {
    // fails first because: the turn goes on, or moves the row, after its heartbeat found the lease taken
    const slow = createRegistry([
      { ...fixtureManifest, leaseSeconds: { ...fixtureManifest.leaseSeconds, prepare: 12, commit: 12 } },
    ]);
    const planted = await plant();
    const key = bucketOf(planted.account);
    await rows("INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('account', $1, 300)", [key]);
    await withAdminClient(env, db.name, async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM app.rate_buckets WHERE scope = 'account' AND key = $1 FOR UPDATE", [
        key,
      ]);
      const running = gate(planted, slow);
      await untilParked();
      await moveToken(planted.id);
      await sleep(4_800); // the heartbeat beats every third of the 12 s lease
      const before = await opOf(planted.id);
      await holder.query("COMMIT");
      expect(await running).toMatchObject({ kind: "lost", id: planted.id });
      expect(await opOf(planted.id)).toEqual(before);
    });
  }, 20_000);
});

describe("close() on a turn", () => {
  it("claims nothing once closing, and a turn parked on its bucket hands its row back to pending", async () => {
    // fails first because: a closing worker still claims, or leaves the row it claimed leased until the lease runs out
    const first = await plant();
    const second = await plant({ queue: first.queue });
    const key = bucketOf(first.account);
    await rows("INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('account', $1, 300)", [key]);
    const closing = new AbortController();
    await withAdminClient(env, db.name, async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM app.rate_buckets WHERE scope = 'account' AND key = $1 FOR UPDATE", [
        key,
      ]);
      const running = turn(first.queue, closing.signal);
      await untilParked();
      closing.abort();
      await holder.query("COMMIT");
      expect(await running).toMatchObject({ kind: "closed" });
    });
    expect(await opOf(first.id)).toMatchObject({ state: "pending", lease_owner: null, token: 2 });
    expect(await turn(first.queue, closing.signal)).toMatchObject({ kind: "closed" });
    expect(await opOf(second.id)).toMatchObject({ state: "pending", token: 1 });
  });
});

// [case, scenario, what the turn answers, the row afterwards, its wait in seconds when it waits]
const CASES: [string, Scenario, string, Record<string, unknown>, number | null][] = [
  [
    "a connected channel and a live target",
    {},
    "dispatched",
    { state: "published", lease_owner: null },
    null,
  ],
  [
    "a disabled channel",
    { channelState: "disabled" },
    "moved",
    { state: "paused", reason_code: "channel_disabled" },
    null,
  ],
  [
    "a channel that needs a reconnect",
    { channelState: "needs_reconnect" },
    "moved",
    { state: "blocked_reconnect", reason_code: "pending" },
    null,
  ],
  [
    "a channel revoked by the provider",
    { channelState: "revoked_by_provider" },
    "moved",
    { state: "blocked_reconnect", reason_code: "pending" },
    null,
  ],
  [
    "a channel the worker cannot see",
    { extra: { channel_id: randomUUID() } },
    "moved",
    { state: "failed", reason_code: null },
    null,
  ],
  ["a deleted post", { deleted: true }, "moved", { state: "failed", reason_code: null }, null],
  ["an archived post", { postStatus: "archived" }, "moved", { state: "failed", reason_code: null }, null],
  ["a settled variant", { scheduleState: "settled" }, "moved", { state: "failed", reason_code: null }, null],
];
describe("the re-read after the claim", () => {
  it.each(CASES)("%s", async (_name, scenario, kind, after, wait) => {
    // fails first because: the turn goes on after the claim without reading the channel and the target again
    const planted = await plant(scenario);
    const closing = new AbortController();
    const result = await runTurn({
      pool: db.pool("worker"),
      logger,
      registry,
      ...wiring,
      queue: planted.queue,
      owner: "owner-w",
      closing: closing.signal,
    });
    expect(result).toMatchObject({ kind, id: planted.id });
    expect(await opOf(planted.id)).toMatchObject({
      ...after,
      effect: kind === "dispatched" ? "confirmed" : "none",
    });
    if (wait !== null) {
      const due = new Date((await opOf(planted.id)).next_attempt_at as string).getTime();
      expect(Math.abs((due - Date.now()) / 1000 - wait)).toBeLessThan(10);
    }
    // Only the turn that passes every check reaches the provider (a prepare and a commit); a turn that does not writes no attempt.
    expect(await attempts(planted.id)).toBe(kind === "dispatched" ? 2 : 0);
  });

  it("counts a wait by the database clock, not by the clock of this process", async () => {
    // fails first because: the wait is a timestamp made from this process's clock, so a skewed clock moves the due time
    const planted = await plant();
    await setTokens(planted.account, "posts", 0);
    const skewed = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    try {
      await gate(planted);
    } finally {
      skewed.mockRestore();
    }
    const [row] = await rows(
      "SELECT extract(epoch FROM next_attempt_at - clock_timestamp())::float8 AS left FROM app.operations WHERE id = $1",
      [planted.id],
    );
    // A full refill takes 10800 s for 300 tokens: one token is 36 s away.
    expect(Math.abs(Number(row?.left) - 36)).toBeLessThan(10);
  });
});

// The bucket gate takes the limits of the manifest in their order (each applies to a publish), a denial is a pre-flight
// move, and one provider account is one bucket whatever channel or workspace holds it.
const limits = (...names: string[]) =>
  createRegistry([
    {
      ...fixtureManifest,
      rateLimits: names.map((name) => ({
        name,
        scope: "account",
        key: "account",
        max: 300,
        windowSeconds: 10800,
      })),
    },
  ]);
const setTokens = (account: string, name: string, tokens: number) =>
  rows(
    `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('account', $1, $2)
     ON CONFLICT (scope, key) DO UPDATE SET tokens = $2, refilled_at = clock_timestamp()`,
    [bucketOf(account, name), tokens],
  );
const tokensOf = async (account: string, name: string) =>
  (
    await rows("SELECT tokens FROM app.rate_buckets WHERE scope = 'account' AND key = $1", [
      bucketOf(account, name),
    ])
  )[0]?.tokens;
const gate = (planted: Planted, using = registry) =>
  runTurn({
    pool: db.pool("worker"),
    logger,
    registry: using,
    ...wiring,
    queue: planted.queue,
    owner: "owner-w",
    closing: new AbortController().signal,
  });
const waitOf = async (id: string) =>
  (new Date((await opOf(id)).next_attempt_at as string).getTime() - Date.now()) / 1000;

describe("a lease too short for a call", () => {
  it("hands the row back to pending instead of leaving it leased", async () => {
    // fails first because: the turn ends lost and the row stays leased until the lease runs out
    const short = createRegistry([
      { ...fixtureManifest, leaseSeconds: { ...fixtureManifest.leaseSeconds, prepare: 1, commit: 1 } },
    ]);
    const planted = await plant();
    expect(await gate(planted, short)).toMatchObject({ kind: "handed_back" });
    expect(await opOf(planted.id)).toMatchObject({ state: "pending", lease_owner: null, token: 2 });
  });
});

describe("a claimed row whose provider is not registered", () => {
  it("is logged with the provider id before the turn throws", async () => {
    // fails first because: the turn throws with nothing in the log that names the provider
    const lines: string[] = [];
    const own = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
    const planted = await plant({ extra: { provider_id: "nobody" } });
    const running = runTurn({
      pool: db.pool("worker"),
      logger: own,
      registry,
      ...wiring,
      queue: planted.queue,
      owner: "owner-w",
      closing: new AbortController().signal,
    });
    await expect(running).rejects.toThrow();
    expect(lines.some((line) => line.includes("no registered provider") && line.includes("nobody"))).toBe(
      true,
    );
  });
});

describe("the bucket gate", () => {
  // [case, the lateness window left in seconds, the state and the reason after the denial]
  const DENIALS: [string, number, string, string | null][] = [
    ["a denial inside the window waits for the retry", 7_200, "retry_wait", null],
    [
      "a denial beyond what is left of the window pauses with a provider cooldown",
      10,
      "paused",
      "provider_cooldown",
    ],
  ];
  it.each(DENIALS)("%s", async (_name, left, state, reason) => {
    // fails first because: no gate, or a denial that is neither a wait nor a pause
    const planted = await plant({ extra: { lateness_deadline: new Date(Date.now() + left * 1000) } });
    await setTokens(planted.account, "posts", 0);
    expect(await gate(planted)).toMatchObject({ kind: "moved", to: state });
    expect(await opOf(planted.id)).toMatchObject({ state, reason_code: reason });
    // A full refill takes 10800 s for 300 tokens: one token is 36 s away.
    expect(Math.abs((await waitOf(planted.id)) - 36)).toBeLessThan(10);
  });

  it("is one bucket for two channels on one provider account, in two workspaces", async () => {
    // fails first because: the key includes the channel or the workspace, so each channel has a bucket of its own
    const other = await admin((a) => seedWorkspace(a));
    const account = `shared-${randomUUID().slice(0, 8)}`;
    const [first, second] = [await plant({ account }), await plant({ account, workspace: other })];
    const [apart] = [await plant()];
    await setTokens(account, "posts", 1);
    expect(await gate(first)).toMatchObject({ kind: "dispatched" });
    expect(await gate(second)).toMatchObject({ kind: "moved", to: "retry_wait" });
    expect(await gate(apart)).toMatchObject({ kind: "dispatched" });
  });

  it("takes the limits in manifest order and stops at the first denial, leaving the tokens it took spent", async () => {
    // fails first because: the limits are taken out of order or all of them after a denial
    const planted = await plant();
    await setTokens(planted.account, "posts", 0);
    expect(await gate(planted, limits("bursts", "posts", "comments"))).toMatchObject({ kind: "moved" });
    expect(Number(await tokensOf(planted.account, "bursts"))).toBeLessThan(300);
    expect(await tokensOf(planted.account, "comments")).toBeUndefined();
  });
});
