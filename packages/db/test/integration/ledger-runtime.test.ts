import { randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

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

const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };
const MAINTENANCE: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "maintenance" };
const USER = asUser(U.admin);
const WORKSPACE_JOB: TenantCtx = { principalKind: "job", principalId: randomUUID(), workspaceIds: [WA] };

interface Answer {
  rows?: Record<string, unknown>[];
  error?: { code?: string; message?: string } | undefined;
}
async function exec(ctx: TenantCtx, sql: string, params: unknown[] = [], pool = "worker"): Promise<Answer> {
  const client = await openTx(db.pool(pool as "worker"), ctx);
  try {
    const answer = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return { rows: answer };
  } catch (error) {
    return { error: error as Answer["error"] };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const ledger = (sql: string, params: unknown[] = []) => exec(LEDGER, sql, params);

interface Prov {
  provider: string;
  channel: string;
  map: Record<string, unknown>;
}
const mapOf = (...providers: string[]) =>
  Object.fromEntries(
    providers.map((id) => [
      id,
      { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 60 } },
    ]),
  );
async function newProvider(state = "connected"): Promise<Prov> {
  const provider = `ledger-run-${randomUUID().slice(0, 8)}`;
  const [made] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, $3) RETURNING id`,
    [WA, provider, state],
  );
  return { provider, channel: made?.id as string, map: mapOf(provider) };
}

interface Target {
  dueIn?: number;
  scheduleState?: string;
  postStatus?: string;
  deleted?: boolean;
}
async function newTarget(p: Prov, o: Target = {}): Promise<string> {
  const [post] = await rows(
    `INSERT INTO app.posts (workspace_id, author_kind, author_id, status, deleted_at)
     VALUES ($1, 'user', $2, $3, CASE WHEN $4 THEN now() END) RETURNING id`,
    [WA, U.editor, o.postStatus ?? "scheduled", o.deleted ?? false],
  );
  const [made] = await rows(
    `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::float8)) RETURNING id`,
    [WA, post?.id, p.channel, o.scheduleState ?? "scheduled", o.dueIn ?? -10],
  );
  return made?.id as string;
}

const admit = (p: Prov, limit = 100) =>
  ledger("SELECT * FROM app.admit_due_targets($1, $2::jsonb)", [limit, JSON.stringify(p.map)]);
const opsOf = (variant: string) =>
  rows(
    `SELECT id, state, reason_code, effect, queue, kind, part_index, fencing_token::int AS token, requested_by,
       extract(epoch FROM next_attempt_at - (SELECT due_at FROM app.post_variants WHERE id = $1)) AS early,
       blocked_since IS NOT NULL AS blocked
     FROM app.operations WHERE variant_id = $1 ORDER BY created_at`,
    [variant],
  );
const reservationsOf = (variant: string) =>
  rows(
    `SELECT r.key, r.amount, r.state FROM app.usage_reservations r JOIN app.operations o ON o.id = r.operation_id
     WHERE o.variant_id = $1`,
    [variant],
  );
const variantState = async (variant: string) =>
  (await rows("SELECT schedule_state FROM app.post_variants WHERE id = $1", [variant]))[0]?.schedule_state;
const outboxTypes = async (id: string) =>
  (
    await rows("SELECT type FROM app.outbox WHERE payload->>'operation_id' = $1 ORDER BY created_at, id", [
      id,
    ])
  ).map((row) => row.type as string);

interface Plant {
  state: string;
  effect?: string;
  token?: number;
  at?: Record<string, number>;
  extra?: Record<string, unknown>;
  queue?: string;
}
async function plant(p: Prov, o: Plant): Promise<string> {
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
    [WA, U.editor],
  );
  const [variant] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
    [WA, post?.id, p.channel],
  );
  const at = { due_at: -120, next_attempt_at: -60, lateness_deadline: 7200, ...o.at };
  const given: Record<string, unknown> = {
    workspace_id: WA,
    variant_id: variant?.id,
    channel_id: p.channel,
    provider_id: p.provider,
    queue: o.queue ?? `publish.${p.provider}`,
    kind: "publish",
    state: o.state,
    effect: o.effect ?? (o.state === "provider_accepted" ? "confirmed" : "none"),
    fencing_token: o.token ?? 1,
    last_actor: "S",
    idempotency_marker: `ledger-run-${randomUUID()}`,
    requested_by: U.editor,
    lease_seconds: 60,
    ...Object.fromEntries(
      Object.entries(at).map(([name, secs]) => [name, new Date(Date.now() + secs * 1000)]),
    ),
    ...o.extra,
  };
  const names = Object.keys(given);
  return admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(given),
    );
    await client.query("COMMIT");
    return made.rows[0].id as string;
  });
}
const LEASED = { lease_owner: "worker-a" };
const opOf = async (id: string) =>
  (
    await rows(
      `SELECT state, effect, reason_code, queue, fencing_token::int AS token, lease_owner,
         lease_expires_at IS NOT NULL AS leased, extract(epoch FROM lease_expires_at - now()) AS lease_in,
         extract(epoch FROM next_check_at - now()) AS check_in
       FROM app.operations WHERE id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;

describe("admission", () => {
  it("admission takes a due target within one tick, never before its due time, and ignores other providers", async () => {
    const p = await newProvider();
    const other = await newProvider();
    const [due, soon, later, foreign] = [
      await newTarget(p, { dueIn: -30 }),
      await newTarget(p, { dueIn: 200 }),
      await newTarget(p, { dueIn: 3600 }),
      await newTarget(other, { dueIn: -30 }),
    ];
    const answer = await admit(p);
    expect(answer.error).toBeUndefined();
    expect(answer.rows?.map((row) => row.state)).toEqual(["pending", "pending"]);
    expect(Object.keys(answer.rows?.[0] ?? {})).toEqual(["operation_id", "workspace_id", "queue", "state"]);
    expect((await opsOf(soon))[0]).toMatchObject({
      queue: `publish.${p.provider}`,
      kind: "publish",
      part_index: 0,
    });
    expect(Number((await opsOf(soon))[0]?.early)).toBe(0);
    expect(Number((await opsOf(due))[0]?.early)).toBe(0);
    expect([(await opsOf(later)).length, (await opsOf(foreign)).length]).toEqual([0, 0]);
    // The row is not claimable before its time: the early admission is the margin, not an early publish.
    const claim = await ledger("SELECT * FROM app.claim_operations($1, 10, 'w1')", [`publish.${p.provider}`]);
    expect(claim.rows?.map((row) => row.id)).toEqual([(await opsOf(due))[0]?.id]);
  });

  it("two concurrent admissions of one target give one operation, one reservation and no error", async () => {
    const p = await newProvider();
    const variant = await newTarget(p);
    const first = await openTx(db.pool("worker"), LEDGER);
    const second = await openTx(db.pool("worker"), LEDGER);
    const args = [10, JSON.stringify(p.map)];
    try {
      await first.query("SELECT * FROM app.admit_due_targets($1, $2::jsonb)", args);
      const racing = await second.query("SELECT * FROM app.admit_due_targets($1, $2::jsonb)", args);
      expect(racing.rows).toEqual([]);
      await first.query("COMMIT");
      await second.query("COMMIT");
    } finally {
      for (const client of [first, second]) await release(client);
    }
    expect((await opsOf(variant)).length).toBe(1);
    expect(await reservationsOf(variant)).toEqual([{ key: "posts_per_month", amount: 1, state: "reserved" }]);
    expect((await admit(p)).rows).toEqual([]);
  });
});

describe("admission faults", () => {
  it("a target the target index refuses is skipped and the others are admitted", async () => {
    const p = await newProvider();
    const held = await newTarget(p, { dueIn: -50 });
    await plant(p, { state: "pending", extra: { variant_id: held } });
    const fine = await newTarget(p, { dueIn: -5 });
    const answer = await admit(p);
    expect(answer.error).toBeUndefined();
    expect(answer.rows?.length).toBe(1);
    expect((await opsOf(fine)).length).toBe(1);
    expect((await opsOf(held)).filter((row) => row.queue === `publish.${p.provider}`).length).toBe(1);
  });

  it("a unique violation on another index is not swallowed by the per-target block", async () => {
    const p = await newProvider();
    // A second index only this provider meets: its second operation violates it, and that is not the target index.
    await rows(
      `CREATE UNIQUE INDEX probe_one_per_provider ON app.operations (provider_id) WHERE provider_id = '${p.provider}'`,
    );
    await newTarget(p, { dueIn: -20 });
    await newTarget(p, { dueIn: -10 });
    try {
      expect((await admit(p)).error?.code).toBe("23505");
    } finally {
      await rows("DROP INDEX app.probe_one_per_provider");
    }
  });
});

describe("admission by state", () => {
  it("a missed admission books no usage, leaves the variant to the rollup (settled) and the next tick inserts nothing", async () => {
    const p = await newProvider();
    const variant = await newTarget(p, { dueIn: -3 * 3600 });
    expect((await admit(p)).rows?.map((row) => row.state)).toEqual(["missed"]);
    expect((await opsOf(variant))[0]).toMatchObject({ state: "missed", effect: "none" });
    expect(await reservationsOf(variant)).toEqual([]);
    expect(await variantState(variant)).toBe("settled");
    expect((await admit(p)).rows).toEqual([]);
    expect((await opsOf(variant)).length).toBe(1);
  });

  const BY_CHANNEL: [string, string, string | null, string, boolean][] = [
    ["connected", "pending", null, "in_progress", true],
    ["disabled", "paused", "channel_disabled", "in_progress", true],
    ["needs_reconnect", "blocked_reconnect", "pending", "held", true],
    ["disconnected", "blocked_reconnect", "pending", "held", true],
    ["revoked_by_provider", "blocked_reconnect", "pending", "held", true],
  ];
  it.each(BY_CHANNEL)(
    "admission on a %s channel inserts %s and reserves one post of usage",
    async (channelState, state, reason, variantAfter, reserved) => {
      const p = await newProvider(channelState);
      const variant = await newTarget(p);
      expect((await admit(p)).error).toBeUndefined();
      expect((await opsOf(variant))[0]).toMatchObject({ state, reason_code: reason, requested_by: U.editor });
      expect(await variantState(variant)).toBe(variantAfter);
      expect((await reservationsOf(variant)).length).toBe(reserved ? 1 : 0);
      expect((await opsOf(variant))[0]?.blocked).toBe(state === "blocked_reconnect");
    },
  );
});

describe("admission skips and events", () => {
  it.each([
    ["a deleted post", { deleted: true }],
    ["an archived post", { postStatus: "archived" }],
    ["a variant that is not scheduled", { scheduleState: "draft" }],
  ])("admission skips %s", async (_name, target) => {
    const p = await newProvider();
    const variant = await newTarget(p, target);
    expect((await admit(p)).rows).toEqual([]);
    expect((await opsOf(variant)).length).toBe(0);
  });

  it("admission writes one operation.admitted row per insert and takes the channel after the target without a deadlock", async () => {
    const p = await newProvider();
    const [one, two] = [await newTarget(p, { dueIn: -20 }), await newTarget(p, { dueIn: -10 })];
    const first = await openTx(db.pool("worker"), LEDGER);
    const second = await openTx(db.pool("worker"), LEDGER);
    try {
      await first.query("SELECT * FROM app.admit_due_targets(1, $1::jsonb)", [JSON.stringify(p.map)]);
      const racing = second.query("SELECT * FROM app.admit_due_targets(1, $1::jsonb)", [
        JSON.stringify(p.map),
      ]);
      await Promise.race([racing, new Promise((resolve) => setTimeout(resolve, 1500))]);
      await first.query("COMMIT");
      expect((await racing).rows.length).toBe(1);
      await second.query("COMMIT");
    } finally {
      for (const client of [first, second]) await release(client);
    }
    for (const variant of [one, two]) {
      const [made] = await opsOf(variant);
      expect(made).toBeDefined();
      expect(await outboxTypes(made?.id as string)).toEqual(["operation.admitted"]);
    }
  });
});

async function release(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK");
  client.release();
}

async function waitsOnLock(pid: number): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if ((await rows("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [pid])).length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the session never waited for a lock");
}

describe("admission on shared channels", () => {
  it("two workers admitting targets of two channels in opposite order never wait on each other", async () => {
    const [one, two] = [await newProvider(), await newProvider()];
    const map = JSON.stringify({ ...one.map, ...two.map });
    // The first worker takes targets on channels one then two, the second takes two then one.
    for (const [at, p] of [one, two, two, one].entries()) await newTarget(p, { dueIn: -40 + at * 10 });
    await withAdminClient(env, db.name, async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM app.channels WHERE id = ANY ($1) FOR UPDATE", [
        [one.channel, two.channel],
      ]);
      const [first, second] = [
        await openTx(db.pool("worker"), LEDGER),
        await openTx(db.pool("worker"), LEDGER),
      ];
      try {
        const call = (client: PoolClient) =>
          client.query("SELECT * FROM app.admit_due_targets(2, $1::jsonb)", [map]);
        const pids = await Promise.all(
          [first, second].map(
            async (c) => (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number,
          ),
        );
        const answers = [call(first)];
        await waitsOnLock(pids[0] as number);
        answers.push(call(second));
        await waitsOnLock(pids[1] as number);
        await holder.query("COMMIT");
        const done = await Promise.all(answers);
        expect(done.reduce((sum, answer) => sum + answer.rows.length, 0)).toBe(4);
        await Promise.all([first.query("COMMIT"), second.query("COMMIT")]);
      } finally {
        for (const client of [first, second]) await release(client);
      }
    });
  });
});

describe("claims", () => {
  it("two workers claim disjoint rows: a second claim runs while the first's transaction is still open", async () => {
    const p = await newProvider();
    const planted = await Promise.all(
      [1, 2, 3, 4].map((n) => plant(p, { state: "pending", at: { next_attempt_at: -n * 10 } })),
    );
    const first = await openTx(db.pool("worker"), LEDGER);
    const second = await openTx(db.pool("worker"), LEDGER);
    const sql = "SELECT * FROM app.claim_operations($1, 2, $2)";
    try {
      const one = await first.query(sql, [`publish.${p.provider}`, "w1"]);
      const two = await second.query(sql, [`publish.${p.provider}`, "w2"]);
      const ids = [...one.rows, ...two.rows].map((row) => row.id as string);
      expect(new Set(ids).size).toBe(4);
      expect([...ids].sort()).toEqual([...planted].sort());
      expect(Object.keys(one.rows[0] ?? {})).toEqual([
        "id",
        "workspace_id",
        "fencing_token",
        "lease_expires_at",
        "kind",
        "state",
      ]);
      await first.query("COMMIT");
      await second.query("COMMIT");
    } finally {
      for (const client of [first, second]) await release(client);
    }
    // The oldest due row (planted last, 40 seconds due) goes to the first worker.
    const oldest = planted[3] as string;
    expect(await opOf(oldest)).toMatchObject({ state: "claimed", token: 2, lease_owner: "w1", leased: true });
    expect(Math.round(Number((await opOf(oldest)).lease_in) / 10)).toBe(6);
    expect(await outboxTypes(oldest)).toEqual(["operation.claimed"]);
  });
});

describe("claim order and heartbeat", () => {
  it("claim_operations takes due rows of its queue inside their lateness window, oldest due first", async () => {
    const p = await newProvider();
    const [late, older, newer] = [
      await plant(p, { state: "pending", at: { next_attempt_at: -500, lateness_deadline: -10 } }),
      await plant(p, { state: "pending", at: { next_attempt_at: -40 } }),
      await plant(p, { state: "pending", at: { next_attempt_at: -20 } }),
    ];
    const notDue = await plant(p, { state: "pending", at: { next_attempt_at: 3600 } });
    const elsewhere = await plant(p, { state: "pending", queue: "publish.priority" });
    const answer = await ledger("SELECT * FROM app.claim_operations($1, 10, 'w1')", [
      `publish.${p.provider}`,
    ]);
    expect(answer.rows?.map((row) => row.id)).toEqual([older, newer]);
    for (const untouched of [late, notDue, elsewhere]) expect((await opOf(untouched)).state).toBe("pending");
  });

  it("heartbeat extends a live lease for its owner and token and answers lost for any other call", async () => {
    const p = await newProvider();
    const live = await plant(p, { state: "claimed", token: 3, at: { lease_expires_at: 30 }, extra: LEASED });
    const dead = await plant(p, { state: "claimed", token: 3, at: { lease_expires_at: -5 }, extra: LEASED });
    const beat = (id: string, token: number, owner: string) =>
      ledger("SELECT * FROM app.heartbeat($1, $2, $3, 90)", [id, token, owner]);
    expect((await beat(live, 2, "worker-a")).rows?.[0]).toMatchObject({ outcome: "lost" });
    expect((await beat(live, 3, "worker-b")).rows?.[0]).toMatchObject({ outcome: "lost" });
    expect((await beat(dead, 3, "worker-a")).rows?.[0]).toMatchObject({ outcome: "lost" });
    expect(Math.round(Number((await opOf(live)).lease_in))).toBe(30);
    expect((await beat(live, 3, "worker-a")).rows?.[0]).toMatchObject({ outcome: "ok" });
    expect(Math.round(Number((await opOf(live)).lease_in))).toBe(90);
    expect(await outboxTypes(live)).toEqual([]);
  });
});

describe("poll claims", () => {
  it("claim_polls leases due processing and provider_accepted rows without a state change and raises the token by one", async () => {
    const p = await newProvider();
    const due = { next_check_at: -30 };
    const [proc, accepted, expired] = [
      await plant(p, { state: "processing", at: due }),
      await plant(p, { state: "provider_accepted", at: { next_check_at: -20 } }),
      await plant(p, {
        state: "processing",
        at: { next_check_at: -10, lease_expires_at: -5 },
        extra: LEASED,
      }),
    ];
    const live = await plant(p, { state: "processing", at: { ...due, lease_expires_at: 60 }, extra: LEASED });
    const notDue = await plant(p, { state: "processing", at: { next_check_at: 3600 } });
    const unknown = await plant(p, { state: "unknown_external_state", at: due, effect: "possible" });
    const answer = await ledger("SELECT * FROM app.claim_polls($1, 10, 'p1', 45)", [`publish.${p.provider}`]);
    expect(answer.rows?.map((row) => row.id)).toEqual([proc, accepted, expired]);
    expect(await opOf(proc)).toMatchObject({
      state: "processing",
      token: 2,
      lease_owner: "p1",
      leased: true,
    });
    expect((await opOf(accepted)).state).toBe("provider_accepted");
    for (const untouched of [live, notDue, unknown]) expect((await opOf(untouched)).token).toBe(1);
    expect(await outboxTypes(proc)).toEqual([]);
  });
});

describe("a stale poller and the reconcile claim", () => {
  it("a stale poller is refused after a poll claim, and the claim's own token carries the move", async () => {
    const p = await newProvider();
    const id = await plant(p, { state: "processing", at: { next_check_at: -5 } });
    const claimed = await ledger("SELECT * FROM app.claim_polls($1, 1, 'p1', 60)", [`publish.${p.provider}`]);
    const token = Number(claimed.rows?.[0]?.fencing_token);
    const move = (held: number) =>
      exec(
        WORKSPACE_JOB,
        "SELECT * FROM app.operation_transition($1, $2, $3, 'processing', 'retry_wait', 'P', '{}')",
        [WA, id, held],
      );
    expect((await move(token - 1)).rows?.[0]).toMatchObject({ outcome: "lost_lease" });
    expect((await move(token)).rows?.[0]).toMatchObject({ outcome: "moved" });
  });

  it("claim_reconciles leases due unknown rows, sends kinds with no read-back to needs_human with no lease, and skips the rest", async () => {
    const p = await newProvider();
    const queue = `reconcile.${p.provider}`;
    const base = { queue, effect: "possible", at: { next_check_at: -30 } };
    const [publish, edit] = [
      await plant(p, { ...base, state: "unknown_external_state", extra: { kind: "publish" } }),
      await plant(p, { ...base, state: "unknown_external_state", extra: { kind: "edit" } }),
    ];
    const notDue = await plant(p, { ...base, state: "unknown_external_state", at: { next_check_at: 3600 } });
    const reconciling = await plant(p, { ...base, state: "reconciling", extra: LEASED });
    const answer = await ledger("SELECT * FROM app.claim_reconciles($1, 10, 'r1', 45, ARRAY['edit'])", [
      queue,
    ]);
    expect(answer.rows?.map((row) => [row.id, row.state])).toEqual([
      [publish, "reconciling"],
      [edit, "needs_human"],
    ]);
    expect(await opOf(publish)).toMatchObject({
      state: "reconciling",
      token: 2,
      lease_owner: "r1",
      leased: true,
    });
    expect(await opOf(edit)).toMatchObject({
      state: "needs_human",
      token: 2,
      lease_owner: null,
      leased: false,
    });
    for (const untouched of [notDue, reconciling]) expect((await opOf(untouched)).token).toBe(1);
  });
});

describe("the fencing token", () => {
  const BUMPS: [string, string, boolean][] = [
    ["claim_polls", "fencing_token + 1", true],
    ["sweep_expired_leases", "fencing_token + 1", true],
    ["claim_polls", "fencing_token + 2", false],
    ["sweep_expired_leases", "fencing_token + 2", false],
    ["claim_polls", "99", false],
    ["claim_polls", "fencing_token - 1", false],
    ["operation_transition", "fencing_token + 1", false],
    ["ledger_heartbeat", "fencing_token + 1", false],
    ["", "fencing_token + 1", false],
  ];
  it.each(BUMPS)("a same-state token change under purpose '%s' to %s %s", async (purpose, value, passes) => {
    const p = await newProvider();
    const id = await plant(p, { state: "processing", token: 3 });
    const outcome = await admin(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.job_purpose', $1, true)", [purpose]);
        await client.query(`UPDATE app.operations SET fencing_token = ${value} WHERE id = $1`, [id]);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.query("ROLLBACK");
      }
    });
    expect(outcome).toBe(passes ? undefined : "SH409");
  });

  it("a stale poller is refused after the poll-lease sweep raised the token by one", async () => {
    const p = await newProvider();
    const id = await plant(p, {
      state: "processing",
      token: 4,
      at: { lease_expires_at: -30 },
      extra: LEASED,
    });
    expect((await ledger("SELECT app.sweep_expired_leases() AS n")).rows?.[0]?.n).toBeGreaterThanOrEqual(1);
    expect(await opOf(id)).toMatchObject({ state: "processing", token: 5, leased: false });
    const stale = await exec(
      WORKSPACE_JOB,
      "SELECT * FROM app.operation_transition($1, $2, 4, 'processing', 'retry_wait', 'P', '{}')",
      [WA, id],
    );
    expect(stale.rows?.[0]).toMatchObject({ outcome: "lost_lease" });
  });
});

describe("sweeps", () => {
  const LEASE_SWEEP: [string, string, string, string][] = [
    ["claimed", "none", "publish", "pending"],
    ["dispatching", "possible", "reconcile", "unknown_external_state"],
    ["reconciling", "possible", "reconcile", "unknown_external_state"],
  ];
  it.each(LEASE_SWEEP)(
    "sweep_expired_leases moves an expired %s lease to %s, drops the lease, raises the token and writes its event",
    async (state, effect, queueKind, to) => {
      const p = await newProvider();
      const expired = await plant(p, {
        state,
        effect,
        token: 2,
        at: { lease_expires_at: -60 },
        extra: LEASED,
      });
      const live = await plant(p, { state, effect, token: 2, at: { lease_expires_at: 60 }, extra: LEASED });
      const swept = await ledger("SELECT app.sweep_expired_leases() AS n");
      expect(Number(swept.rows?.[0]?.n)).toBeGreaterThanOrEqual(1);
      expect(await opOf(expired)).toMatchObject({
        state: to,
        effect,
        token: 3,
        leased: false,
        lease_owner: null,
      });
      expect((await opOf(expired)).queue).toBe(`${queueKind}.${p.provider}`);
      expect(await outboxTypes(expired)).toEqual([`operation.${to}`]);
      expect(await opOf(live)).toMatchObject({ state, token: 2, leased: true });
    },
  );
});

describe("a swept dispatching row", () => {
  it("a swept dispatching row is taken by claim_reconciles in the same tick and never resent", async () => {
    const p = await newProvider();
    const id = await plant(p, {
      state: "dispatching",
      effect: "possible",
      at: { lease_expires_at: -60 },
      extra: LEASED,
    });
    // A provider that cannot wait for its first read-back says so: its entry has a first back-off of 0.
    await ledger("SELECT app.sweep_expired_leases($1::jsonb)", [
      JSON.stringify({ [p.provider]: { first_backoff_seconds: 0 } }),
    ]);
    expect(Math.abs(Number((await opOf(id)).check_in))).toBeLessThan(5);
    const taken = await ledger("SELECT * FROM app.claim_reconciles($1, 5, 'r1', 60, ARRAY[]::text[])", [
      `reconcile.${p.provider}`,
    ]);
    expect(taken.rows?.map((row) => [row.id, row.state])).toEqual([[id, "reconciling"]]);
    expect((await opOf(id)).effect).toBe("possible");
  });
});

describe("due moves", () => {
  const DUE_MOVES: [string, Plant, string][] = [
    ["a pending row past its lateness", { state: "pending", at: { lateness_deadline: -10 } }, "missed"],
    ["a retry_wait row past its lateness", { state: "retry_wait", at: { lateness_deadline: -10 } }, "missed"],
    [
      "a paused row past its lateness",
      { state: "paused", at: { lateness_deadline: -10 }, extra: { reason_code: "quota" } },
      "missed",
    ],
    [
      "a retry_wait row whose retry is due",
      { state: "retry_wait", queue: "reconcile.x", at: { next_attempt_at: -5 } },
      "pending",
    ],
    [
      "a paused row whose cooldown ended",
      { state: "paused", at: { next_attempt_at: -5 }, extra: { reason_code: "provider_cooldown" } },
      "pending",
    ],
    ["a retry_wait row not yet due", { state: "retry_wait", at: { next_attempt_at: 600 } }, "retry_wait"],
    [
      "a paused row still in its cooldown",
      { state: "paused", at: { next_attempt_at: 600 }, extra: { reason_code: "provider_cooldown" } },
      "paused",
    ],
    ["a paused row for quota", { state: "paused", extra: { reason_code: "quota" } }, "paused"],
    ["a paused row for entitlement", { state: "paused", extra: { reason_code: "entitlement" } }, "paused"],
    [
      "a paused row for a withdrawn capability",
      { state: "paused", extra: { reason_code: "capability_withdrawn" } },
      "paused",
    ],
    ["a paused row for a sunset api", { state: "paused", extra: { reason_code: "api_sunset" } }, "paused"],
  ];
  it.each(DUE_MOVES)(
    "sweep_due_moves handles %s once, and a second sweep changes nothing",
    async (_name, planted, after) => {
      const p = await newProvider();
      const id = await plant(p, planted);
      expect((await ledger("SELECT app.sweep_due_moves()")).error).toBeUndefined();
      expect((await opOf(id)).state).toBe(after);
      const types = await outboxTypes(id);
      expect((await ledger("SELECT app.sweep_due_moves()")).error).toBeUndefined();
      expect(await outboxTypes(id)).toEqual(types);
      if (planted.queue && after === "pending") expect((await opOf(id)).queue).toBe(`publish.${p.provider}`);
    },
  );
});

describe("the pause of a disabled channel", () => {
  it.each([
    ["connected", "pending"],
    ["disabled", "paused"],
  ])(
    "a paused row for channel_disabled on a %s channel is %s after the sweep",
    async (channelState, after) => {
      const p = await newProvider(channelState);
      const id = await plant(p, { state: "paused", extra: { reason_code: "channel_disabled" } });
      expect((await ledger("SELECT app.sweep_due_moves()")).error).toBeUndefined();
      expect((await opOf(id)).state).toBe(after);
    },
  );
});

const sweepBlocked = () => ledger("SELECT app.sweep_blocked_moves() AS n");
const heldFor = async (id: string) =>
  Number(
    (await rows("SELECT extract(epoch FROM blocked_total) AS s FROM app.operations WHERE id = $1", [id]))[0]
      ?.s,
  );
const BLOCKED = (reason: string, at: Record<string, number> = {}, effect?: string): Plant => ({
  state: "blocked_reconnect",
  ...(effect ? { effect } : {}),
  at: { blocked_since: -3600, ...at },
  extra: { reason_code: reason },
});

describe("posts held for a reconnect", () => {
  const ENTER: [string, string, string, Plant][] = [
    ["needs_reconnect", "pending", "blocked_reconnect", { state: "pending" }],
    [
      "disconnected",
      "retry_wait",
      "blocked_reconnect",
      { state: "retry_wait", at: { next_attempt_at: 600 } },
    ],
    [
      "revoked_by_provider",
      "paused",
      "blocked_reconnect",
      { state: "paused", extra: { reason_code: "quota" } },
    ],
    ["disabled", "pending", "pending", { state: "pending" }],
    ["connected", "pending", "pending", { state: "pending" }],
  ];
  it.each(ENTER)(
    "on a %s channel a %s row is %s after the sweep, and a held one is held from now with reason pending",
    async (channelState, _from, after, planted) => {
      const p = await newProvider(channelState);
      const id = await plant(p, planted);
      expect((await sweepBlocked()).error).toBeUndefined();
      const [op] = await rows(
        "SELECT state, reason_code, extract(epoch FROM now() - blocked_since) AS since FROM app.operations WHERE id = $1",
        [id],
      );
      expect(op?.state).toBe(after);
      if (after !== "blocked_reconnect") return;
      expect(op?.reason_code).toBe("pending");
      expect(Math.abs(Number(op?.since))).toBeLessThan(5);
      expect(await outboxTypes(id)).toEqual(["operation.blocked_reconnect"]);
    },
  );

  it("a held row stays held while its channel is still away and its deadline is ahead", async () => {
    const p = await newProvider("needs_reconnect");
    await rows("UPDATE app.channels SET reconnect_deadline = now() + interval '1 day' WHERE id = $1", [
      p.channel,
    ]);
    const id = await plant(p, BLOCKED("pending"));
    expect((await sweepBlocked()).error).toBeUndefined();
    expect((await opOf(id)).state).toBe("blocked_reconnect");
  });
});

describe("held posts after a reconnect", () => {
  const LEAVE: [string, string, string | null, Plant][] = [
    [
      "effect none blocked before its lateness ended",
      "pending",
      null,
      BLOCKED("pending", { lateness_deadline: -600 }),
    ],
    [
      "effect none blocked after its lateness ended",
      "needs_human",
      "past_due_after_reconnect",
      BLOCKED("pending", { lateness_deadline: -7200, blocked_since: -600 }),
    ],
    [
      "an outcome that may have happened",
      "unknown_external_state",
      null,
      BLOCKED("unknown_external_state", {}, "possible"),
    ],
    [
      "an accepted post",
      "provider_accepted",
      null,
      BLOCKED("provider_accepted", { poll_deadline: 600 }, "confirmed"),
    ],
  ];
  it.each(LEAVE)(
    "after a reconnect, %s goes to %s with the held time added to its lateness",
    async (_name, after, reason, planted) => {
      const p = await newProvider();
      const id = await plant(p, { ...planted, queue: `reconcile.${p.provider}` });
      expect((await sweepBlocked()).error).toBeUndefined();
      const op = await opOf(id);
      expect([op.state, op.reason_code]).toEqual([after, reason]);
      expect(await heldFor(id)).toBeGreaterThan(planted.at?.blocked_since === -600 ? 595 : 3595);
      if (after === "pending") expect(op.queue).toBe(`publish.${p.provider}`);
      if (after !== "pending" && after !== "needs_human") expect(Number(op.check_in)).toBeLessThan(5);
      const types = await outboxTypes(id);
      expect((await sweepBlocked()).error).toBeUndefined();
      expect(await outboxTypes(id)).toEqual(types);
    },
  );
});

describe("held posts after the reconnect deadline", () => {
  it.each([
    ["none", "pending", "cancelled", "draft"],
    ["possible", "unknown_external_state", "needs_human", "held"],
    ["confirmed", "provider_accepted", "needs_human", "held"],
  ])(
    "after the reconnect deadline a row with effect %s held as %s goes to %s and its variant is %s",
    async (effect, reason, after, variantAfter) => {
      const p = await newProvider("needs_reconnect");
      await rows("UPDATE app.channels SET reconnect_deadline = now() - interval '1 second' WHERE id = $1", [
        p.channel,
      ]);
      const id = await plant(p, BLOCKED(reason, {}, effect));
      expect((await sweepBlocked()).error).toBeUndefined();
      expect([(await opOf(id)).state, (await opOf(id)).reason_code]).toEqual([after, null]);
      const [variant] = await rows("SELECT variant_id FROM app.operations WHERE id = $1", [id]);
      expect(await variantState(variant?.variant_id as string)).toBe(variantAfter);
    },
  );
});

describe("held posts are moved once", () => {
  it("a reconnect that lands while the sweep runs is never overtaken by the deadline: the held post resumes", async () => {
    const p = await newProvider("needs_reconnect");
    await rows("UPDATE app.channels SET reconnect_deadline = now() - interval '1 second' WHERE id = $1", [
      p.channel,
    ]);
    const id = await plant(p, BLOCKED("pending", { lateness_deadline: -600 }));
    await admin(async (reconnect) => {
      await reconnect.query("BEGIN");
      await reconnect.query(
        "UPDATE app.channels SET connection_state = 'connected', reconnect_deadline = NULL WHERE id = $1",
        [p.channel],
      );
      expect((await sweepBlocked()).error).toBeUndefined();
      expect((await opOf(id)).state).toBe("blocked_reconnect");
      await reconnect.query("COMMIT");
    });
    expect((await sweepBlocked()).error).toBeUndefined();
    expect((await opOf(id)).state).toBe("pending");
  });

  it("a held post resumes as the same operation after a reconnect and admission adds none", async () => {
    const p = await newProvider("needs_reconnect");
    const variant = await newTarget(p);
    expect((await admit(p)).error).toBeUndefined();
    await rows("UPDATE app.channels SET connection_state = 'connected' WHERE id = $1", [p.channel]);
    expect((await sweepBlocked()).error).toBeUndefined();
    expect((await admit(p)).rows).toEqual([]);
    expect((await opsOf(variant)).map((op) => op.state)).toEqual(["pending"]);
    const claimed = await ledger("SELECT * FROM app.claim_operations($1, 5, 'w1')", [
      `publish.${p.provider}`,
    ]);
    expect(claimed.rows?.length).toBe(1);
  });

  it("a row whose post another transaction holds is skipped, and moved by the next sweep", async () => {
    const p = await newProvider();
    const id = await plant(p, BLOCKED("pending", { lateness_deadline: -600 }));
    await admin(async (holder) => {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id JOIN app.operations o ON o.variant_id = v.id
         WHERE o.id = $1 FOR NO KEY UPDATE OF p`,
        [id],
      );
      expect((await sweepBlocked()).error).toBeUndefined();
      await holder.query("ROLLBACK");
    });
    expect((await opOf(id)).state).toBe("blocked_reconnect");
    expect((await sweepBlocked()).error).toBeUndefined();
    expect((await opOf(id)).state).toBe("pending");
  });
});

describe("sweep isolation", () => {
  // Each sweep takes its rows one at a time: the move the guard refuses for one row leaves the others moved. The refused
  // move is made by removing its row of the transition table for the test and putting it back.
  const ISOLATION: [string, string, [string, string, string], Plant, Plant][] = [
    [
      "sweep_due_moves",
      "SELECT app.sweep_due_moves() AS n",
      ["paused", "missed", "S"],
      { state: "paused", at: { lateness_deadline: -10 }, extra: { reason_code: "quota" } },
      { state: "pending", at: { lateness_deadline: -10 } },
    ],
    [
      "sweep_blocked_moves",
      "SELECT app.sweep_blocked_moves() AS n",
      ["blocked_reconnect", "pending", "S"],
      BLOCKED("pending"),
      BLOCKED("unknown_external_state", {}, "possible"),
    ],
    [
      "sweep_expired_leases",
      "SELECT app.sweep_expired_leases() AS n",
      ["claimed", "pending", "X"],
      { state: "claimed", at: { lease_expires_at: -60 }, extra: LEASED },
      { state: "dispatching", effect: "possible", at: { lease_expires_at: -60 }, extra: LEASED },
    ],
  ];
  it.each(ISOLATION)(
    "%s: one row whose move is refused does not stop the others",
    async (_name, call, move, refused, fine) => {
      const p = await newProvider();
      const [bad, good] = [await plant(p, refused), await plant(p, fine)];
      const saved = await rows(
        "SELECT * FROM app.ledger_transitions WHERE from_state = $1 AND to_state = $2 AND actor = $3",
        move,
      );
      await rows(
        "DELETE FROM app.ledger_transitions WHERE from_state = $1 AND to_state = $2 AND actor = $3",
        move,
      );
      let answer: Answer;
      try {
        answer = await ledger(call);
      } finally {
        for (const row of saved) {
          await rows(
            "INSERT INTO app.ledger_transitions (row_no, from_state, to_state, actor, guard, bumps_fence) VALUES ($1, $2, $3, $4, $5, $6)",
            [row.row_no, row.from_state, row.to_state, row.actor, row.guard, row.bumps_fence],
          );
        }
      }
      expect(answer.error).toBeUndefined();
      expect((await opOf(bad)).state).toBe(refused.state);
      expect((await opOf(good)).state).not.toBe(fine.state);
    },
  );
});

const key = () => randomUUID().replaceAll("-", "").repeat(2);
describe("the buckets", () => {
  const take = (k: string, scope: string, capacity = 2, window = 60, cost = 1) =>
    ledger("SELECT * FROM app.bucket_take_scoped($1, $2, $3, $4, $5)", [k, scope, capacity, window, cost]);
  const pause = (k: string, scope: string, until: string, reason = "cooldown") =>
    ledger("SELECT app.bucket_pause($1, $2, now() + $3::interval, $4)", [k, scope, until, reason]);

  it("the same scope and key is one bucket, another scope or key is separate", async () => {
    const [one, two] = [key(), key()];
    const answers = [
      await take(one, "account"),
      await take(one, "account"),
      await take(one, "account"),
      await take(one, "chat"),
      await take(two, "account"),
    ];
    expect(answers.map((a) => a.rows?.[0]?.allowed)).toEqual([true, true, false, true, true]);
    expect(Number(answers[2]?.rows?.[0]?.retry_after_seconds)).toBeGreaterThan(0);
  });

  it("a pause refuses until its time, never shortens an earlier pause, and a bucket created by a pause starts full", async () => {
    const [paused, fresh] = [key(), key()];
    await take(paused, "account");
    await pause(paused, "account", "60 seconds");
    await pause(paused, "account", "10 seconds");
    const refused = await take(paused, "account");
    expect(refused.rows?.[0]).toMatchObject({ allowed: false });
    expect(Number(refused.rows?.[0]?.retry_after_seconds)).toBeGreaterThan(50);
    await rows("UPDATE app.rate_buckets SET paused_until = now() - interval '1 second' WHERE key = $1", [
      paused,
    ]);
    expect((await take(paused, "account")).rows?.[0]).toMatchObject({ allowed: true });
    await pause(fresh, "webhook", "30 seconds", "retry_after");
    await rows("UPDATE app.rate_buckets SET paused_until = NULL WHERE key = $1", [fresh]);
    expect((await take(fresh, "webhook")).rows?.[0]).toMatchObject({ allowed: true, remaining: 1 });
  });
});

const lease = (publish: number) =>
  JSON.stringify({ any: { margin_seconds: 300, lease_seconds: { publish, edit: 60, delete: 60 } } });
const BAD_KEY = "not-a-digest";
const BAD: [string, string, unknown[]][] = [
  [
    "a fixed scope in the scoped take",
    "SELECT * FROM app.bucket_take_scoped($1, 'login_ip', 2, 60, 1)",
    [key()],
  ],
  ["a scope outside the five", "SELECT * FROM app.bucket_take_scoped($1, 'user', 2, 60, 1)", [key()]],
  ["capacity 0", "SELECT * FROM app.bucket_take_scoped($1, 'account', 0, 60, 1)", [key()]],
  ["capacity over 10000", "SELECT * FROM app.bucket_take_scoped($1, 'account', 10001, 60, 1)", [key()]],
  ["window 0", "SELECT * FROM app.bucket_take_scoped($1, 'account', 2, 0, 1)", [key()]],
  ["window over a day", "SELECT * FROM app.bucket_take_scoped($1, 'account', 2, 86401, 1)", [key()]],
  ["a cost of 2", "SELECT * FROM app.bucket_take_scoped($1, 'account', 2, 60, 2)", [key()]],
  ["a key that is not a digest", "SELECT * FROM app.bucket_take_scoped($1, 'account', 2, 60, 1)", [BAD_KEY]],
  [
    "a pause scope outside the five",
    "SELECT app.bucket_pause($1, 'login_ip', now() + interval '1 minute', 'x')",
    [key()],
  ],
  [
    "a pause over 24 hours",
    "SELECT app.bucket_pause($1, 'account', now() + interval '25 hours', 'x')",
    [key()],
  ],
  [
    "an empty pause reason",
    "SELECT app.bucket_pause($1, 'account', now() + interval '1 minute', '')",
    [key()],
  ],
  [
    "a pause reason over 64 characters",
    `SELECT app.bucket_pause($1, 'account', now() + interval '1 minute', '${"x".repeat(65)}')`,
    [key()],
  ],
  ["claim_operations with limit 0", "SELECT * FROM app.claim_operations('publish.x', 0, 'w')", []],
  ["claim_operations with limit 501", "SELECT * FROM app.claim_operations('publish.x', 501, 'w')", []],
  ["claim_polls with lease 0", "SELECT * FROM app.claim_polls('publish.x', 1, 'w', 0)", []],
  ["claim_polls with lease 3601", "SELECT * FROM app.claim_polls('publish.x', 1, 'w', 3601)", []],
  [
    "claim_reconciles with lease 0",
    "SELECT * FROM app.claim_reconciles('reconcile.x', 1, 'w', 0, ARRAY[]::text[])",
    [],
  ],
  [
    "claim_reconciles with limit 501",
    "SELECT * FROM app.claim_reconciles('reconcile.x', 501, 'w', 60, ARRAY[]::text[])",
    [],
  ],
  ["claim_operations with no owner", "SELECT * FROM app.claim_operations('publish.x', 1, NULL)", []],
  ["claim_polls with no owner", "SELECT * FROM app.claim_polls('publish.x', 1, NULL, 60)", []],
  [
    "claim_reconciles with no owner",
    "SELECT * FROM app.claim_reconciles('reconcile.x', 1, NULL, 60, ARRAY[]::text[])",
    [],
  ],
  ["heartbeat with no owner", `SELECT * FROM app.heartbeat('${randomUUID()}', 1, NULL, 60)`, []],
  ["heartbeat with extend 0", `SELECT * FROM app.heartbeat('${randomUUID()}', 1, 'w', 0)`, []],
  ["heartbeat with extend 3601", `SELECT * FROM app.heartbeat('${randomUUID()}', 1, 'w', 3601)`, []],
  ["admission with limit 0", "SELECT * FROM app.admit_due_targets(0, '{}'::jsonb)", []],
  ["admission with limit 501", "SELECT * FROM app.admit_due_targets(501, '{}'::jsonb)", []],
  ["admission with a provider lease of 0", "SELECT * FROM app.admit_due_targets(1, $1::jsonb)", [lease(0)]],
  [
    "admission with a provider lease of 1.5",
    "SELECT * FROM app.admit_due_targets(1, $1::jsonb)",
    [lease(1.5)],
  ],
];
describe("argument bounds", () => {
  it.each(BAD)("refuses %s", async (_name, sql, params) => {
    expect((await ledger(sql, params)).error?.code).toBe("22023");
  });
});

describe("the worker's read of channels", () => {
  const COLUMNS =
    "id, workspace_id, provider_id, provider_account_id, instance_host, connection_state, capability_epoch";
  const read = (workspace: string, columns: string, channel: string) =>
    exec(
      { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger", workspaceIds: [workspace] },
      `SELECT ${columns} FROM app.channels WHERE id = $1`,
      [channel],
    );
  it("the worker reads the seven columns of a channel of its workspace, no other column, and no channel of another workspace", async () => {
    const p = await newProvider();
    const own = await read(WA, COLUMNS, p.channel);
    expect(own.rows?.[0]).toMatchObject({
      id: p.channel,
      workspace_id: WA,
      provider_id: p.provider,
      connection_state: "connected",
    });
    expect(Object.keys(own.rows?.[0] ?? {})).toEqual(COLUMNS.split(", "));
    for (const refused of ["display_name", "handle", "token_expires_at", "health"]) {
      expect((await read(WA, refused, p.channel)).error?.code, refused).toBe("42501");
    }
    expect((await read(randomUUID(), COLUMNS, p.channel)).rows).toEqual([]);
  });
});

const CALLS: [string, string, unknown[]][] = [
  ["admit_due_targets", "SELECT * FROM app.admit_due_targets(1, '{}'::jsonb)", []],
  ["claim_operations", "SELECT * FROM app.claim_operations('publish.none', 1, 'w')", []],
  ["claim_polls", "SELECT * FROM app.claim_polls('publish.none', 1, 'w', 60)", []],
  [
    "claim_reconciles",
    "SELECT * FROM app.claim_reconciles('reconcile.none', 1, 'w', 60, ARRAY[]::text[])",
    [],
  ],
  ["heartbeat", `SELECT * FROM app.heartbeat('${randomUUID()}', 1, 'w', 60)`, []],
  ["sweep_expired_leases", "SELECT app.sweep_expired_leases()", []],
  ["sweep_due_moves", "SELECT app.sweep_due_moves()", []],
  ["sweep_blocked_moves", "SELECT app.sweep_blocked_moves()", []],
  [
    "bucket_take_scoped",
    `SELECT * FROM app.bucket_take_scoped('${"a".repeat(64)}', 'account', 2, 60, 1)`,
    [],
  ],
  [
    "bucket_pause",
    `SELECT app.bucket_pause('${"a".repeat(64)}', 'account', now() + interval '1 minute', 'x')`,
    [],
  ],
];
describe("who may run the runtime definers", () => {
  const CALLERS: [string, TenantCtx, string][] = [
    ["a user principal", USER, "worker"],
    ["a job under the maintenance purpose", MAINTENANCE, "worker"],
    ["the app role", LEDGER, "app"],
  ];
  const CASES = CALLS.flatMap(([name, sql]) =>
    CALLERS.map(([who, ctx, pool]) => [name, who, sql, ctx, pool] as const),
  );
  it.each(CASES)("%s refuses %s with 42501", async (_name, _who, sql, ctx, pool) => {
    expect((await exec(ctx, sql, [], pool)).error?.code).toBe("42501");
  });

  it("the admission purpose changes post_variants.schedule_state and a maintenance job cannot", async () => {
    const p = await newProvider();
    const variant = await newTarget(p, { scheduleState: "scheduled" });
    const write = (purpose: string) =>
      admin(async (client) => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE shoutory_definer");
          await client.query("SELECT set_config('app.job_purpose', $1, true)", [purpose]);
          const done = await client.query(
            "UPDATE app.post_variants SET schedule_state = 'held' WHERE id = $1",
            [variant],
          );
          return done.rowCount;
        } finally {
          await client.query("ROLLBACK");
        }
      });
    expect(await write("admit_due_targets")).toBe(1);
    // A job session under the maintenance purpose changes nothing: neither as the worker role nor under the definer role.
    expect(await write("maintenance")).toBe(0);
    const direct = await exec(
      MAINTENANCE,
      "UPDATE app.post_variants SET schedule_state = 'held' WHERE id = $1",
      [variant],
    );
    expect(direct.error?.code).toBe("42501");
  });
});
