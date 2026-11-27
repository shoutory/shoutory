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
import { asUser, OA, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const ctxOf = (purpose?: string): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: [WA],
  ...(purpose === undefined ? {} : { jobPurpose: purpose }),
});
const WORKER = ctxOf();
const LEDGER = ctxOf("ledger");
const OWNER = asUser(U.owner);

const channel: Record<string, string> = {};
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    for (const state of ["connected", "needs_reconnect"]) {
      const made = await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
         VALUES ($1, 'fixture', 'profile', $2, $2, $3) RETURNING id`,
        [WA, `effects-${state}`, state],
      );
      channel[state] = made.rows[0].id;
    }
  });
});
afterAll(() => db.drop());

interface Plant {
  state?: string;
  effect?: string;
  kind?: string;
  channel?: string;
  extra?: Record<string, unknown>;
}
interface Planted {
  id: string;
  post: string;
  variant: string;
}
async function plant(o: Plant = {}): Promise<Planted> {
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
    [WA, U.editor],
  );
  const chosen = channel[o.channel ?? "connected"];
  const [variant] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
    [WA, post?.id, chosen],
  );
  const state = o.state ?? "pending";
  const leased = ["claimed", "dispatching", "reconciling"].includes(state);
  const given: Record<string, unknown> = {
    workspace_id: WA,
    variant_id: variant?.id,
    channel_id: chosen,
    provider_id: "fixture",
    queue: state === "unknown_external_state" ? "reconcile.fixture" : "publish.fixture",
    kind: o.kind ?? "publish",
    state,
    effect: o.effect ?? "none",
    fencing_token: 1,
    last_actor: "S",
    due_at: new Date(Date.now() - 60_000),
    next_attempt_at: new Date(Date.now() - 60_000),
    next_check_at: new Date(Date.now() - 60_000),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `effects-${randomUUID()}`,
    requested_by: U.editor,
    ...(leased
      ? { lease_owner: "worker-a", lease_expires_at: new Date(Date.now() + 60_000), heartbeat_at: new Date() }
      : {}),
    ...o.extra,
  };
  const names = Object.keys(given);
  const id = await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(given),
    );
    await client.query("COMMIT");
    return made.rows[0].id as string;
  });
  return { id, post: post?.id as string, variant: variant?.id as string };
}
const opOf = async (id: string) =>
  (
    await rows(
      `SELECT state, effect, queue, attempt_count, step_cursor, provider_refs, superseded_by_operation_id AS by,
         supersedes_operation_id AS of, next_escalation_at IS NOT NULL AS escalated, unverified_until IS NOT NULL AS horizon,
         extract(epoch FROM next_check_at - clock_timestamp())::float8 AS check_in,
         extract(epoch FROM unverified_until - clock_timestamp())::float8 AS horizon_in
       FROM app.operations WHERE id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;
const reserve = (op: string) =>
  rows(
    "INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount) VALUES ($1, $2, $3, 'posts_per_month', 1)",
    [WA, OA, op],
  );
async function attempt(op: string, effect: string, finished: boolean, quota = false): Promise<void> {
  const [made] = await rows(
    `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, started_at,
       effect_started_at, finished_at, effect)
     VALUES ($1, $2, 1, 'commit', 1, now() - interval '5 minutes', now() - interval '5 minutes',
       CASE WHEN $4 THEN now() - interval '4 minutes' END, $3) RETURNING id`,
    [WA, op, effect, finished],
  );
  if (quota) {
    await rows(
      `INSERT INTO app.provider_quota_ledger (workspace_id, provider_id, provider_account_id, quota_key, operation_id,
         attempt_id) VALUES ($1, 'fixture', 'effects-connected', 'posts', $2, $3)`,
      [WA, op, made?.id],
    );
  }
}
const usageOf = async (op: string) =>
  (await rows("SELECT state FROM app.usage_reservations WHERE operation_id = $1", [op])).map((r) => r.state);
const quotaOf = async (op: string) =>
  (await rows("SELECT state FROM app.provider_quota_ledger WHERE operation_id = $1", [op])).map(
    (r) => r.state,
  );
const targetOf = async (p: Planted) =>
  (
    await rows(
      `SELECT v.schedule_state AS variant, p.status AS post, p.targets_total AS total, p.targets_published AS published,
         v.published_at IS NOT NULL AS dated FROM app.post_variants v JOIN app.posts p ON p.id = v.post_id WHERE v.id = $1`,
      [p.variant],
    )
  )[0];

interface Answer {
  rows?: Record<string, unknown>[];
  error?: { code?: string } | undefined;
}
async function exec(ctx: TenantCtx, sql: string, params: unknown[] = []): Promise<Answer> {
  const client = await openTx(db.pool(ctx.principalKind === "job" ? "worker" : "app"), ctx);
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
const receipt = (op: string) =>
  exec(
    WORKER,
    "SELECT * FROM app.record_evidence($1::uuid, $2::uuid, 'accepted', 'receipt', 'post', $3::jsonb)",
    [
      WA,
      op,
      JSON.stringify({ source: "fixture", external_id: "ext-1", permalink: "https://example.test/p/1" }),
    ],
  );
const cancel = (op: string) => exec(OWNER, "SELECT app.operation_cancel($1::uuid, $2::uuid)", [WA, op]);
const sweepDue = (providers: object = {}) =>
  exec(LEDGER, "SELECT app.sweep_due_moves($1::jsonb) AS n", [JSON.stringify(providers)]);
const sweepLeases = (providers: object = {}) =>
  exec(LEDGER, "SELECT app.sweep_expired_leases($1::jsonb) AS n", [JSON.stringify(providers)]);
const START =
  "SELECT * FROM app.operation_attempt_start($1::uuid, $2::uuid, $3::bigint, 'worker-a', $4, $5::jsonb)";
const LATE = { lateness_deadline: new Date(Date.now() - 60_000) };

type Move = (op: string) => Promise<Answer>;
const BOOKS: [string, Plant, boolean, Move, string[], string[]][] = [
  [
    "a receipt books usage and quota",
    { state: "dispatching", effect: "possible" },
    true,
    receipt,
    ["booked"],
    ["booked"],
  ],
  ["a cancel releases usage", { state: "pending" }, false, cancel, ["released"], []],
  ["a cancel refunds its quota row", { state: "pending" }, true, cancel, ["released"], ["refunded"]],
  [
    "a missed post refunds its quota row",
    { state: "pending", extra: LATE },
    true,
    () => sweepDue(),
    ["released"],
    ["refunded"],
  ],
  [
    "a pending post past its window is missed and releases usage",
    { state: "pending", extra: LATE },
    false,
    () => sweepDue(),
    ["released"],
    [],
  ],
  [
    "a retry that used its attempts fails and releases usage",
    { state: "retry_wait", extra: { attempt_count: 5 } },
    false,
    () => sweepDue({ fixture: { max_attempts: 5 } }),
    ["released"],
    [],
  ],
];
describe("the commit start of a processing row", () => {
  it("moves it to dispatching as the poller, marks the effect and leaves no deadline behind", async () => {
    const made = (
      await plant({
        state: "processing",
        extra: {
          lease_owner: "worker-a",
          lease_expires_at: new Date(Date.now() + 60_000),
          processing_deadline: new Date(Date.now() + 300_000),
        },
      })
    ).id;
    const started = await exec(LEDGER, START, [WA, made, 1, "commit", "{}"]);
    expect(started.rows?.[0]).toMatchObject({ outcome: "started" });
    const [row] = await rows(
      "SELECT state, effect, attempt_count, last_actor, processing_deadline FROM app.operations WHERE id = $1",
      [made],
    );
    expect(row).toMatchObject({
      state: "dispatching",
      effect: "possible",
      attempt_count: 1,
      last_actor: "P",
      processing_deadline: null,
    });
  });
});

describe("usage and quota", () => {
  it.each(BOOKS)("%s", async (_name, planted, quota, move, usage, quotas) => {
    const op = (await plant(planted)).id;
    await reserve(op);
    if (quota) await attempt(op, "possible", false, true);
    expect((await move(op)).error).toBeUndefined();
    expect(await usageOf(op)).toEqual(usage);
    expect(await quotaOf(op)).toEqual(quotas);
  });

  it("refunds the quota of an attempt shown to have sent nothing and keeps the usage", async () => {
    const op = (await plant({ state: "dispatching", effect: "possible" })).id;
    await reserve(op);
    await attempt(op, "none", true, true);
    const moved = await exec(
      WORKER,
      "SELECT * FROM app.operation_transition($1::uuid, $2::uuid, 1, 'dispatching', 'retry_wait', 'W', '{}')",
      [WA, op],
    );
    expect(moved.rows?.[0]).toMatchObject({ outcome: "moved" });
    expect(await quotaOf(op)).toEqual(["refunded"]);
    expect(await usageOf(op)).toEqual(["reserved"]);
  });

  it("denies a start when the quota window is full, writes nothing, and reserves again after a refund", async () => {
    const quotas = JSON.stringify({ posts: { capacity: 1, window_seconds: 3600 } });
    await rows("DELETE FROM app.provider_quota_ledger");
    const held = (await plant({ state: "dispatching", effect: "possible" })).id;
    await attempt(held, "possible", false, true);
    const next = (await plant({ state: "claimed" })).id;
    const denied = await exec(LEDGER, START, [WA, next, 1, "commit", quotas]);
    expect(denied.error).toBeUndefined();
    expect(denied.rows?.[0]).toMatchObject({ outcome: "quota_denied" });
    expect(await opOf(next)).toMatchObject({ state: "claimed", effect: "none", attempt_count: 0 });
    await rows("UPDATE app.provider_quota_ledger SET state = 'refunded' WHERE operation_id = $1", [held]);
    const again = await exec(LEDGER, START, [WA, next, 1, "commit", quotas]);
    expect(again.rows?.[0]).toMatchObject({ outcome: "started" });
    expect(await quotaOf(next)).toEqual(["reserved"]);
  });
});

const ROLLUPS: [string, Plant, Move, string, string][] = [
  ["published", { state: "dispatching", effect: "possible" }, receipt, "settled", "published"],
  [
    "failed",
    { state: "retry_wait", extra: { attempt_count: 5 } },
    () => sweepDue({ fixture: { max_attempts: 5 } }),
    "settled",
    "failed",
  ],
  ["missed", { state: "pending", extra: LATE }, () => sweepDue(), "settled", "missed"],
  ["cancelled", { state: "pending" }, cancel, "draft", "draft"],
  [
    "needs_human",
    { state: "unknown_external_state" },
    () =>
      exec(LEDGER, "SELECT * FROM app.claim_reconciles('reconcile.fixture', 50, 'w', 60, ARRAY['publish'])"),
    "held",
    "needs_attention",
  ],
  [
    "blocked_reconnect",
    { state: "claimed", channel: "needs_reconnect" },
    (op) =>
      exec(
        WORKER,
        "SELECT * FROM app.operation_transition($1::uuid, $2::uuid, 1, 'claimed', 'blocked_reconnect', 'W', '{}')",
        [WA, op],
      ),
    "held",
    "needs_attention",
  ],
];
describe("the rollup of the post and its target", () => {
  it.each(ROLLUPS)(
    "a move to %s writes the target and the post",
    async (_name, planted, move, variant, post) => {
      const made = await plant(planted);
      expect((await move(made.id)).error).toBeUndefined();
      expect(await targetOf(made)).toMatchObject({ variant, post });
    },
  );

  it("counts the triple and dates the target when a post is published", async () => {
    const made = await plant({ state: "dispatching", effect: "possible" });
    await receipt(made.id);
    expect(await targetOf(made)).toEqual({
      variant: "settled",
      post: "published",
      total: 1,
      published: 1,
      dated: true,
    });
  });

  it("does not touch the post on a claim or a start", async () => {
    const made = await plant({ state: "pending" });
    const before = await rows(
      "SELECT p.updated_at AS p, v.updated_at AS v FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id WHERE p.id = $1",
      [made.post],
    );
    const claim = await exec(LEDGER, "SELECT * FROM app.claim_operations('publish.fixture', 50, 'worker-a')");
    expect(claim.error).toBeUndefined();
    const [claimed] = await rows("SELECT fencing_token::int AS token FROM app.operations WHERE id = $1", [
      made.id,
    ]);
    expect(
      (await exec(LEDGER, START, [WA, made.id, claimed?.token, "commit", "{}"])).rows?.[0],
    ).toMatchObject({ outcome: "started" });
    expect(
      await rows(
        "SELECT p.updated_at AS p, v.updated_at AS v FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id WHERE p.id = $1",
        [made.post],
      ),
    ).toEqual(before);
  });
});

describe("the deadlines of an unknown outcome", () => {
  it("sets the first read-back and the unverified horizon from the provider's entry, with defaults for an unlisted one", async () => {
    const lapsed = { lease_expires_at: new Date(Date.now() - 5_000) };
    const listed = (await plant({ state: "dispatching", effect: "possible", extra: lapsed })).id;
    const unlisted = (
      await plant({ state: "dispatching", effect: "possible", extra: { ...lapsed, provider_id: "other" } })
    ).id;
    const entry = { fixture: { first_backoff_seconds: 0, unverified_horizon_days: 30 } };
    expect((await sweepLeases(entry)).error).toBeUndefined();
    expect(await opOf(listed)).toMatchObject({
      state: "unknown_external_state",
      queue: "reconcile.fixture",
      horizon: true,
    });
    expect(Math.abs(Number((await opOf(listed)).check_in))).toBeLessThan(5);
    expect(Math.abs(Number((await opOf(listed)).horizon_in) / 86400 - 30)).toBeLessThan(0.01);
    expect(await opOf(unlisted)).toMatchObject({ state: "unknown_external_state", horizon: false });
    expect(Math.abs(Number((await opOf(unlisted)).check_in) - 60)).toBeLessThan(5);
  });

  it("ends an unverified horizon that came as unverified and stamps the escalation, and leaves an unlisted provider alone", async () => {
    const due = { unverified_until: new Date(Date.now() - 5_000) };
    const listed = (await plant({ state: "unknown_external_state", effect: "possible", extra: due })).id;
    const unlisted = (
      await plant({
        state: "unknown_external_state",
        effect: "possible",
        extra: { ...due, provider_id: "other" },
      })
    ).id;
    expect((await sweepDue({ fixture: { max_attempts: 5 } })).error).toBeUndefined();
    expect(await opOf(listed)).toMatchObject({ state: "unverified", escalated: true });
    expect(await opOf(unlisted)).toMatchObject({ state: "unknown_external_state", escalated: false });
  });
});

describe("the limits of the progress a worker records", () => {
  const BAD: [string, object][] = [
    ["prepare:1", { blob: "x".repeat(70_000) }],
    ["upload-everything", { upload: "u-1" }],
    ["prepare:1", [] as unknown as object],
  ];
  it.each(BAD)(
    "%s with oversized, malformed or non-object input is refused with 22023",
    async (cursor, refs) => {
      const made = (await plant({ state: "claimed" })).id;
      const answer = await exec(
        LEDGER,
        "SELECT * FROM app.operation_record_progress($1::uuid, $2::uuid, 1, $3, $4::jsonb)",
        [WA, made, cursor, JSON.stringify(refs)],
      );
      expect(answer.error?.code).toBe("22023");
      expect(await opOf(made)).toMatchObject({ step_cursor: null });
    },
  );
});

describe("the retention of the quota ledger", () => {
  it("is seven days", async () => {
    const [found] = await rows(
      "SELECT retain::text AS retain, event_column FROM app.retention_classes WHERE class = 'app.provider_quota_ledger'",
    );
    expect(found).toEqual({ retain: "7 days", event_column: "at" });
  });
});

describe("the horizon of a worker's own unknown outcome", () => {
  it("is set when a worker moves a sent post to unknown_external_state, and refused elsewhere", async () => {
    const made = (await plant({ state: "dispatching", effect: "possible" })).id;
    const call = (to: string, from: string, id: string, changes: object) =>
      exec(WORKER, "SELECT * FROM app.operation_transition($1::uuid, $2::uuid, 1, $3, $4, 'W', $5::jsonb)", [
        WA,
        id,
        from,
        to,
        JSON.stringify(changes),
      ]);
    const moved = await call("unknown_external_state", "dispatching", made, { unverified_horizon_days: 30 });
    expect(moved.rows?.[0]).toMatchObject({ outcome: "moved" });
    expect(Math.abs(Number((await opOf(made)).horizon_in) / 86400 - 30)).toBeLessThan(0.01);
    const elsewhere = (await plant({ state: "claimed" })).id;
    expect(
      (await call("processing", "claimed", elsewhere, { unverified_horizon_days: 30 })).error?.code,
    ).toBe("22023");
    const bounded = (await plant({ state: "dispatching", effect: "possible" })).id;
    expect(
      (await call("unknown_external_state", "dispatching", bounded, { unverified_horizon_days: 0 })).error
        ?.code,
    ).toBe("22023");
  });
});

describe("the escalation of a needs_human operation", () => {
  it("is stamped on entry into needs_human", async () => {
    const made = (await plant({ state: "unknown_external_state", effect: "possible" })).id;
    await exec(
      LEDGER,
      "SELECT * FROM app.claim_reconciles('reconcile.fixture', 50, 'w', 60, ARRAY['publish'])",
    );
    expect(await opOf(made)).toMatchObject({ state: "needs_human", escalated: true });
  });
});

describe("the progress of a worker and the counts", () => {
  it("records the cursor and references while the lease and token hold, and moves nothing", async () => {
    const made = (await plant({ state: "claimed" })).id;
    const call = (token: number) =>
      exec(
        LEDGER,
        "SELECT * FROM app.operation_record_progress($1::uuid, $2::uuid, $3::bigint, 'prepare:1', $4::jsonb)",
        [WA, made, token, JSON.stringify({ upload: "u-1" })],
      );
    expect((await call(99)).rows?.[0]).toMatchObject({ outcome: "lost_lease" });
    expect((await call(1)).rows?.[0]).toMatchObject({ outcome: "recorded" });
    expect(await opOf(made)).toMatchObject({
      state: "claimed",
      step_cursor: "prepare:1",
      provider_refs: { upload: "u-1" },
    });
  });
});

describe("the next check a poller sets", () => {
  // [state, token, outcome]: only the holder of a processing row can set its next check, which also ends its lease
  it.each([
    ["processing", 1, "recorded"],
    ["processing", 99, "lost_lease"],
    ["claimed", 1, "lost_lease"],
  ] as const)("a poll delay on a %s row with token %i is %s", async (state, token, outcome) => {
    const made = (
      await plant({
        state,
        extra:
          state === "processing"
            ? { lease_owner: "worker-a", lease_expires_at: new Date(Date.now() + 60_000) }
            : {},
      })
    ).id;
    const answer = await exec(
      LEDGER,
      "SELECT * FROM app.operation_record_progress($1::uuid, $2::uuid, $3::bigint, NULL, NULL, 45)",
      [WA, made, token],
    );
    expect(answer.rows?.[0]).toMatchObject({ outcome });
    const [now] = await rows(
      "SELECT lease_owner, extract(epoch FROM next_check_at - clock_timestamp())::float8 AS check_in FROM app.operations WHERE id = $1",
      [made],
    );
    if (outcome === "lost_lease") expect(Number(now?.check_in)).toBeLessThan(0);
    else {
      expect(now?.lease_owner).toBeNull();
      expect(Number(now?.check_in)).toBeGreaterThan(40);
      expect(Number(now?.check_in)).toBeLessThanOrEqual(45);
    }
  });
});

describe("the counts of the ledger", () => {
  it("counts every state of the ledger, with a zero for an empty one", async () => {
    const count = async () =>
      new Map(
        (await exec(OWNER, "SELECT * FROM app.ledger_state_counts()")).rows?.map((r) => [
          r.state,
          Number(r.total),
        ]),
      );
    const before = await count();
    await plant({ state: "needs_human", effect: "possible" });
    await plant({ state: "needs_human", effect: "possible" });
    const after = await count();
    expect(after.size).toBe(17);
    expect((after.get("needs_human") ?? 0) - (before.get("needs_human") ?? 0)).toBe(2);
  });
});

describe("a superseded operation", () => {
  it.each(["possible", "none"])(
    "is linked both ways, hands its usage to the new operation and leaves the target in progress (effect %s)",
    async (effect) => {
      const old = await plant({ state: "needs_human", effect });
      await reserve(old.id);
      const done = await exec(
        OWNER,
        "SELECT * FROM app.resolve_operation($1::uuid, $2::uuid, 'supersede', $3::jsonb)",
        [WA, old.id, JSON.stringify({ ack_text: "this may send the post a second time" })],
      );
      const made = String(done.rows?.[0]?.new_operation_id);
      expect(await opOf(old.id)).toMatchObject({ state: "superseded_after_unknown_outcome", by: made });
      expect(await opOf(made)).toMatchObject({ state: "pending", of: old.id });
      expect(await usageOf(old.id)).toEqual(["released"]);
      expect(await usageOf(made)).toEqual(["reserved"]);
      expect(await targetOf(old)).toMatchObject({ variant: "in_progress", post: "scheduled" });
    },
  );
});
