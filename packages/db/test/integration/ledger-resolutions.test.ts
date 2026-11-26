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
import { asUser, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const job = (purpose?: string): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: [WA],
  ...(purpose === undefined ? {} : { jobPurpose: purpose }),
});
const WORKER = job();
const LEDGER = job("ledger");
const OWNER = asUser(U.owner);
type Pool = "app" | "worker";
const poolOf = (ctx: TenantCtx): Pool => (ctx.principalKind === "job" ? "worker" : "app");

const channelsOf: Record<string, Record<string, string>> = {};
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    for (const workspace of [WA, WB]) {
      const mine: Record<string, string> = {};
      for (const state of ["connected", "needs_reconnect", "disconnected", "disabled"]) {
        const made = await client.query(
          `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
           VALUES ($1, 'fixture-oauth', 'profile', $2, $2, $3) RETURNING id`,
          [workspace, `resolutions-${state}`, state],
        );
        mine[state] = made.rows[0].id;
      }
      channelsOf[workspace] = mine;
    }
  });
});
afterAll(() => db.drop());

interface Plant {
  ws?: string;
  state?: string;
  effect?: string;
  kind?: string;
  channel?: string;
  token?: number;
  lease?: boolean;
  of?: Planted;
}
interface Planted {
  id: string;
  post: string;
  variant: string;
}
async function plant(o: Plant = {}): Promise<Planted> {
  const ws = o.ws ?? WA;
  const [post] = o.of
    ? [{ id: o.of.post }]
    : await rows(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
        [ws, U.editor],
      );
  const channel = channelsOf[ws]?.[o.channel ?? "connected"];
  const [variant] = o.of
    ? [{ id: o.of.variant }]
    : await rows(
        "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'in_progress') RETURNING id",
        [ws, post?.id, channel],
      );
  const state = o.state ?? "claimed";
  const given: Record<string, unknown> = {
    workspace_id: ws,
    variant_id: variant?.id,
    channel_id: channel,
    provider_id: "fixture-oauth",
    queue: "publish.fixture-oauth",
    kind: o.kind ?? "publish",
    state,
    effect: o.effect ?? "none",
    fencing_token: o.token ?? 1,
    last_actor: "S",
    due_at: new Date(),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `resolutions-${randomUUID()}`,
    requested_by: U.editor,
    ...(o.lease === false ||
    !["claimed", "processing", "dispatching", "reconciling", "provider_accepted"].includes(state)
      ? {}
      : {
          lease_owner: "worker-a",
          lease_expires_at: new Date(Date.now() + 60_000),
          heartbeat_at: new Date(),
        }),
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
      `SELECT state, effect, fencing_token::int AS token, attempt_count, lease_owner, step_cursor,
         (SELECT count(*)::int FROM app.operation_attempts a WHERE a.operation_id = o.id) AS attempts,
         (SELECT count(*)::int FROM app.operation_resolutions r WHERE r.operation_id = o.id) AS resolutions
       FROM app.operations o WHERE o.id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;

interface Answer {
  rows?: Record<string, unknown>[];
  error?: { code?: string; message?: string } | undefined;
}
async function exec(ctx: TenantCtx, sql: string, params: unknown[], before: string[] = []): Promise<Answer> {
  const client = await openTx(db.pool(poolOf(ctx)), ctx);
  try {
    for (const statement of before) await client.query(statement);
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

const START = "SELECT * FROM app.operation_attempt_start($1::uuid, $2::uuid, $3::bigint, $4, $5, $6::jsonb)";
const FINISH = "SELECT * FROM app.operation_attempt_finish($1::uuid, $2::uuid, $3::bigint, $4::jsonb)";
const TRANSITION =
  "SELECT * FROM app.operation_transition($1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7::jsonb)";
const EVIDENCE = "SELECT * FROM app.record_evidence($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)";
const RESOLVE = "SELECT * FROM app.resolve_operation($1::uuid, $2::uuid, $3, $4::jsonb)";
const start = (id: string, token = 1, owner = "worker-a", ctx = LEDGER, ws = WA, step = "commit") =>
  exec(ctx, START, [ws, id, token, owner, step, "{}"]);
const LATER = { local_due: "2099-01-01T10:00", due_tz: "UTC", due_at: "2099-01-01T10:00:00Z" };
const resolve = (id: string, kind: string, args: Record<string, unknown> = {}, ctx = OWNER) =>
  exec(ctx, RESOLVE, [WA, id, kind, JSON.stringify(kind === "reschedule" ? { ...LATER, ...args } : args)]);

describe("the effect marker and the fence of an attempt", () => {
  it("the effect marker is committed and visible from a second session when attempt_start returns", async () => {
    const planted = await plant({ state: "claimed" });
    const answer = await start(planted.id);
    expect(answer.rows?.[0]).toMatchObject({ outcome: "started" });
    expect(await opOf(planted.id)).toMatchObject({
      state: "dispatching",
      effect: "possible",
      token: 1,
      attempt_count: 1,
      attempts: 1,
    });
    const [attempt] = await rows(
      `SELECT step, attempt_no, effect, fencing_token::int AS token, effect_started_at IS NOT NULL AS marked,
         finished_at IS NULL AS open FROM app.operation_attempts WHERE operation_id = $1`,
      [planted.id],
    );
    expect(attempt).toEqual({
      step: "commit",
      attempt_no: 1,
      effect: "possible",
      token: 1,
      marked: true,
      open: true,
    });
  });

  const STALE: [string, number, string][] = [
    ["a token that moved on", 99, "worker-a"],
    ["another lease owner", 1, "worker-b"],
  ];
  it.each(STALE)("a stale holder cannot start an attempt: %s", async (_name, token, owner) => {
    const planted = await plant({ state: "claimed" });
    expect((await start(planted.id, token, owner)).rows?.[0]).toMatchObject({ outcome: "lost_lease" });
    expect(await opOf(planted.id)).toMatchObject({
      state: "claimed",
      effect: "none",
      attempt_count: 0,
      attempts: 0,
    });
  });
});

const QUIET: [string, string, string][] = [
  ["prepare", "claimed", "none"],
  ["prepare", "processing", "none"],
  ["poll", "provider_accepted", "confirmed"],
  ["read_back", "reconciling", "possible"],
];
describe("the start of a step that sends nothing", () => {
  it.each(QUIET)(
    "a %s start in %s writes the attempt row with no move and the effect kept",
    async (step, state, effect) => {
      const planted = await plant({ state, effect });
      expect((await start(planted.id, 1, "worker-a", LEDGER, WA, step)).rows?.[0]).toMatchObject({
        outcome: "started",
      });
      expect(await opOf(planted.id)).toMatchObject({
        state,
        effect,
        token: 1,
        attempt_count: 0,
        attempts: 1,
      });
      const [attempt] = await rows(
        `SELECT step, attempt_no, effect, effect_started_at IS NULL AS unmarked
         FROM app.operation_attempts WHERE operation_id = $1`,
        [planted.id],
      );
      expect(attempt).toEqual({ step, attempt_no: 1, effect, unmarked: true });
    },
  );

  it.each([
    ["claimed", "W"],
    ["processing", "P"],
  ])(
    "a committing start from %s moves to dispatching by %s, keeping the token and the lease",
    async (from, actor) => {
      const planted = await plant({ state: from });
      expect((await start(planted.id)).rows?.[0]).toMatchObject({ outcome: "started" });
      expect(await opOf(planted.id)).toMatchObject({
        state: "dispatching",
        effect: "possible",
        token: 1,
        lease_owner: "worker-a",
      });
      expect((await rows("SELECT last_actor FROM app.operations WHERE id = $1", [planted.id]))[0]).toEqual({
        last_actor: actor,
      });
    },
  );

  it("numbers every start but counts only the commit start", async () => {
    const planted = await plant({ state: "claimed" });
    await start(planted.id, 1, "worker-a", LEDGER, WA, "prepare");
    await start(planted.id);
    expect(await opOf(planted.id)).toMatchObject({ state: "dispatching", attempt_count: 1, attempts: 2 });
    const numbers = await rows(
      "SELECT attempt_no, step FROM app.operation_attempts WHERE operation_id = $1 ORDER BY attempt_no",
      [planted.id],
    );
    expect(numbers).toEqual([
      { attempt_no: 1, step: "prepare" },
      { attempt_no: 2, step: "commit" },
    ]);
  });
});

describe("the finish of an attempt", () => {
  it("a stale token cannot finish an attempt and the right token finishes it once", async () => {
    const planted = await plant({ state: "claimed" });
    await start(planted.id);
    const [attempt] = await rows("SELECT id FROM app.operation_attempts WHERE operation_id = $1", [
      planted.id,
    ]);
    const result = JSON.stringify({ effect: "possible", http_status: 502, error_class: "timeout" });
    expect((await exec(LEDGER, FINISH, [WA, attempt?.id, 99, result])).rows?.[0]).toMatchObject({
      outcome: "lost_lease",
    });
    expect(
      (await rows("SELECT finished_at FROM app.operation_attempts WHERE id = $1", [attempt?.id]))[0],
    ).toEqual({
      finished_at: null,
    });
    expect((await exec(LEDGER, FINISH, [WA, attempt?.id, 1, result])).rows?.[0]).toMatchObject({
      outcome: "finished",
    });
    expect(
      (await rows("SELECT http_status FROM app.operation_attempts WHERE id = $1", [attempt?.id]))[0],
    ).toEqual({
      http_status: 502,
    });
  });
});

type Proof = "attempt" | "absent" | "human";
const RESETS: [number, string, string, string, Proof, string | null][] = [
  [42, "needs_human", "retry_wait", "U", "absent", null],
  [42, "needs_human", "retry_wait", "U", "human", null],
  [44, "needs_human", "cancelled", "U", "absent", null],
  [44, "needs_human", "cancelled", "U", "human", null],
];
const ATTEMPT = (op: string, effect: string, finished: boolean, ws = WA) =>
  rows(
    `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, started_at,
       effect_started_at, finished_at, effect)
     VALUES ($1, $2, 1, 'commit', 1, now() - interval '10 minutes', now() - interval '10 minutes',
       CASE WHEN $4 THEN now() - interval '9 minutes' END, $3)`,
    [ws, op, effect, finished],
  );
const EVIDENCE_ROW = (op: string, kind: string, level: string, ago: string, ws = WA) =>
  rows(
    `INSERT INTO app.operation_evidence (workspace_id, operation_id, kind, level, source, observed_at)
     VALUES ($1, $2, $3, $4, 'fixture', now() - $5::interval)`,
    [ws, op, kind, level, ago],
  );
// Every proof there is, on another operation: it must never count for the one that moves.
async function decoy(op: string, ws = WA): Promise<void> {
  await ATTEMPT(op, "none", true, ws);
  await EVIDENCE_ROW(op, "absent", "read_back", "1 minute", ws);
  await EVIDENCE_ROW(op, "human_confirmed", "human", "0 seconds", ws);
}
async function nearMiss(op: string, proof: Proof): Promise<void> {
  await ATTEMPT(op, "possible", true);
  if (proof !== "attempt") await EVIDENCE_ROW(op, "absent", "read_back", "30 minutes");
  // An attestation written before the latest attempt began says nothing about that attempt.
  if (proof === "human") await EVIDENCE_ROW(op, "human_confirmed", "human", "30 minutes");
}
async function prove(op: string, proof: Proof): Promise<void> {
  if (proof === "attempt") {
    await rows("DELETE FROM app.operation_attempts WHERE operation_id = $1", [op]);
    await ATTEMPT(op, "none", true);
  } else if (proof === "absent") await EVIDENCE_ROW(op, "absent", "read_back", "1 minute");
  else await EVIDENCE_ROW(op, "human_confirmed", "human", "0 seconds");
}
const RESET_FROM: Record<string, string> = { dispatching: "possible", provider_accepted: "confirmed" };
const resetPlant = (from: string, ws = WA) =>
  plant({ ws, state: from, effect: RESET_FROM[from] ?? "possible", lease: from !== "needs_human" });

const direct = (id: string, to: string, actor: string, reason: string | null, keep = false) =>
  admin(async (client): Promise<Answer> => {
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE app.operations SET state = $2, ${keep ? "" : "effect = 'none', "}last_actor = $3, reason_code = $4,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = $1`,
        [id, to, actor, reason],
      );
      await client.query("COMMIT");
      return {};
    } catch (error) {
      await client.query("ROLLBACK");
      return { error: error as Answer["error"] };
    }
  });

describe("the guard that lets an effect go back to none", () => {
  it.each(RESETS)(
    "row %i (%s to %s) is refused with no proof and with a near miss, and passes with its proof (%s)",
    async (_row, from, to, actor, proof, reason) => {
      const planted = await resetPlant(from);
      expect((await direct(planted.id, to, actor, reason)).error?.code).toBe("SH409");
      await nearMiss(planted.id, proof);
      expect((await direct(planted.id, to, actor, reason)).error?.code).toBe("SH409");
      await decoy((await resetPlant(from)).id);
      await decoy((await resetPlant(from, WB)).id, WB);
      expect((await direct(planted.id, to, actor, reason)).error?.code).toBe("SH409");
      await prove(planted.id, proof);
      expect((await direct(planted.id, to, actor, reason)).error).toBeUndefined();
      expect(await opOf(planted.id)).toMatchObject({ state: to, effect: "none" });
    },
  );
});

const BACKSTOP: [number, string, string, string, Proof, string | null][] = [
  [19, "dispatching", "retry_wait", "W", "attempt", null],
  [20, "dispatching", "failed", "W", "attempt", null],
  [21, "dispatching", "paused", "W", "attempt", "provider_cooldown"],
  [24, "provider_accepted", "failed", "P", "absent", null],
  [36, "reconciling", "retry_wait", "R", "absent", null],
  [42, "needs_human", "retry_wait", "U", "absent", null],
  [44, "needs_human", "cancelled", "U", "absent", null],
];
describe("a move into a state that holds no effect", () => {
  it.each(BACKSTOP)(
    "row %i (%s to %s) is refused when the statement keeps the effect, even with the proof in place",
    async (_row, from, to, actor, proof, reason) => {
      const planted = await resetPlant(from);
      await nearMiss(planted.id, proof);
      await prove(planted.id, proof);
      expect((await direct(planted.id, to, actor, reason, true)).error?.code).toBe("SH409");
      expect(await opOf(planted.id)).toMatchObject({ state: from });
    },
  );
});

const VIA: [number, string, string, string, Proof, Record<string, unknown>][] = [
  [19, "dispatching", "retry_wait", "W", "attempt", {}],
  [20, "dispatching", "failed", "W", "attempt", {}],
  [21, "dispatching", "paused", "W", "attempt", { reason_code: "provider_cooldown" }],
  [24, "provider_accepted", "failed", "P", "absent", {}],
  [36, "reconciling", "retry_wait", "R", "absent", {}],
];
describe("the moves that reset an effect, by operation_transition", () => {
  it.each(VIA)(
    "operation_transition runs row %i only with its proof: no proof, a near miss and another operation's proof are refused, then it moves",
    async (_row, from, to, actor, proof, changes) => {
      const planted = await resetPlant(from);
      const args = [WA, planted.id, 1, from, to, actor, JSON.stringify(changes)];
      expect((await exec(WORKER, TRANSITION, args)).error?.code).toBe("SH409");
      await nearMiss(planted.id, proof);
      expect((await exec(WORKER, TRANSITION, args)).error?.code).toBe("SH409");
      await decoy((await resetPlant(from)).id);
      await decoy((await resetPlant(from, WB)).id, WB);
      expect((await exec(WORKER, TRANSITION, args)).error?.code).toBe("SH409");
      await prove(planted.id, proof);
      expect((await exec(WORKER, TRANSITION, args)).rows?.[0]).toMatchObject({ outcome: "moved" });
      expect(await opOf(planted.id)).toMatchObject({ state: to, effect: "none" });
    },
  );

  it("a caller that sets app.idempotent_resend itself still cannot pass the guard without proof", async () => {
    const planted = await resetPlant("reconciling");
    const args = (changes: object) => [
      WA,
      planted.id,
      1,
      "reconciling",
      "retry_wait",
      "R",
      JSON.stringify(changes),
    ];
    const forged = await exec(WORKER, TRANSITION, args({}), [
      "SELECT set_config('app.idempotent_resend', 'true', true)",
    ]);
    expect(forged.error?.code).toBe("SH409");
    expect(await opOf(planted.id)).toMatchObject({ state: "reconciling", effect: "possible" });
    const flagged = await exec(WORKER, TRANSITION, args({ idempotent_resend: true }));
    expect(flagged.rows?.[0]).toMatchObject({ outcome: "moved" });
    expect(await opOf(planted.id)).toMatchObject({ state: "retry_wait", effect: "none" });
  });
});

describe("the post and variant locks of a definer that ends an operation", () => {
  it("two sessions ending operations of one post never deadlock and the rollup lands once", async () => {
    const planted = await plant({ state: "dispatching", effect: "possible" });
    await admin(async (holder) => {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM app.posts WHERE id = $1 FOR UPDATE", [planted.post]);
      const ending = await openTx(db.pool("worker"), WORKER);
      const first = ending
        .query(EVIDENCE, [
          WA,
          planted.id,
          "accepted",
          "receipt",
          "post",
          JSON.stringify({ source: "fixture", external_id: "ext-1" }),
        ])
        .then(
          () => ({ error: undefined as unknown }),
          (error: unknown) => ({ error }),
        );
      let answered = false;
      void first.then(() => {
        answered = true;
      });
      await sleep(400);
      // An ending that does not wait for the post has taken the operation row and holds it until it commits.
      if (answered) await ending.query("COMMIT");
      const second = await holder
        .query("SELECT 1 FROM app.operations WHERE id = $1 FOR UPDATE", [planted.id])
        .then(
          () => ({ error: undefined as unknown }),
          (error: unknown) => ({ error }),
        );
      await holder.query("COMMIT");
      const done = await first;
      await ending.query(done.error ? "ROLLBACK" : "COMMIT").catch(() => undefined);
      ending.release();
      expect(done.error).toBeUndefined();
      expect(second.error).toBeUndefined();
    });
    expect(await opOf(planted.id)).toMatchObject({ state: "published" });
    expect(
      (
        await rows(
          `SELECT p.status, p.targets_total, p.targets_published, v.schedule_state
             FROM app.posts p JOIN app.post_variants v ON v.post_id = p.id WHERE p.id = $1`,
          [planted.post],
        )
      )[0],
    ).toEqual({ status: "published", targets_total: 1, targets_published: 1, schedule_state: "settled" });
  });
});

type Row = [string, string, string, string | null, boolean, string];
const RESOLUTIONS: Row[] = [
  ["attest_published", "needs_human", "publish", "published", true, "possible"],
  ["attest_published", "unverified", "publish", "published", true, "possible"],
  ["attest_published", "pending", "publish", null, true, "none"],
  ["attest_not_executed", "needs_human", "publish", "retry_wait", true, "possible"],
  ["attest_not_executed", "unverified", "publish", null, true, "possible"],
  ["publish_late", "needs_human", "publish", "retry_wait", false, "none"],
  ["publish_late", "missed", "publish", "missed", false, "none"],
  ["publish_late", "published", "publish", null, false, "confirmed"],
  ["reschedule", "needs_human", "publish", "cancelled", false, "none"],
  ["reschedule", "missed", "publish", "missed", false, "none"],
  ["reschedule", "published", "publish", null, false, "confirmed"],
  ["drop", "needs_human", "publish", "cancelled", false, "none"],
  ["drop", "pending", "publish", null, false, "none"],
  ["dismiss", "needs_human", "publish", "unverified", false, "possible"],
  ["dismiss", "unverified", "publish", null, false, "possible"],
  ["supersede", "needs_human", "publish", "superseded_after_unknown_outcome", true, "possible"],
  ["supersede", "unverified", "publish", "superseded_after_unknown_outcome", true, "possible"],
  ["supersede", "claimed", "publish", null, true, "none"],
  ["confirm_removed", "needs_human", "delete", "published", true, "possible"],
  ["confirm_removed", "needs_human", "publish", null, true, "possible"],
];
const ACK = { ack_text: "this may send the post a second time", note: "checked by hand" };

describe("resolve_operation", () => {
  it.each(RESOLUTIONS)(
    "%s on %s (%s operation) ends in %s",
    async (kind, from, opKind, after, stepUp, effect) => {
      const planted = await plant({ state: from, kind: opKind, effect });
      const answer = await resolve(planted.id, kind, ACK);
      const [resolution] = await rows(
        "SELECT kind, actor, step_up_at IS NOT NULL AS stepped FROM app.operation_resolutions WHERE operation_id = $1",
        [planted.id],
      );
      if (after === null) {
        expect(answer.error?.code).toBe("SH409");
        expect(await opOf(planted.id)).toMatchObject({ state: from, resolutions: 0 });
        return;
      }
      expect(answer.error).toBeUndefined();
      expect(await opOf(planted.id)).toMatchObject({ state: after, resolutions: 1 });
      expect(resolution).toEqual({ kind, actor: U.owner, stepped: stepUp });
      const made = answer.rows?.[0]?.new_operation_id;
      const expectNew = kind === "supersede" || (kind === "publish_late" && from === "missed");
      expect(made !== null && made !== undefined).toBe(expectNew);
    },
  );

  const CHANNELS: [string, string, string, boolean][] = [
    ["attest_not_executed", "needs_human", "needs_reconnect", true],
    ["attest_not_executed", "needs_human", "disabled", true],
    ["publish_late", "needs_human", "disconnected", true],
    ["supersede", "needs_human", "needs_reconnect", true],
    ["attest_published", "needs_human", "needs_reconnect", false],
    ["dismiss", "needs_human", "disconnected", false],
    ["drop", "needs_human", "needs_reconnect", false],
  ];
  it.each(CHANNELS)("%s on %s with a %s channel: refused is %s", async (kind, state, channel, refused) => {
    const effect = ["drop", "publish_late"].includes(kind) ? "none" : "possible";
    const planted = await plant({ state, channel, effect });
    const answer = await resolve(planted.id, kind, ACK);
    if (refused) {
      expect(answer.error?.code).toBe("SH409");
      expect(await opOf(planted.id)).toMatchObject({ state, resolutions: 0 });
    } else {
      expect(answer.error).toBeUndefined();
      expect(await opOf(planted.id)).toMatchObject({ resolutions: 1 });
    }
  });
});

describe("the time of a reschedule", () => {
  // [kind, the arguments, the error state]
  const BAD_TIME: [string, Record<string, unknown>, string][] = [
    ["reschedule", { due_at: "2020-01-01T10:00:00Z" }, "SH422"],
    ["drop", LATER, "22023"],
    ["reschedule", { due_at: null }, "22023"],
    ["reschedule", { local_due: null }, "22023"],
    ["reschedule", { due_tz: null }, "22023"],
    ["reschedule", { due_at: 42 }, "22023"],
  ];
  it.each(BAD_TIME)("a %s with the time %j changes nothing", async (kind, args, code) => {
    const planted = await plant({ state: "needs_human", effect: "none" });
    const answer = await exec(OWNER, RESOLVE, [
      WA,
      planted.id,
      kind,
      JSON.stringify(kind === "reschedule" ? { ...LATER, ...args } : args),
    ]);
    expect(answer.error?.code).toBe(code);
    expect(await opOf(planted.id)).toMatchObject({ state: "needs_human", resolutions: 0 });
  });

  it("a second reschedule of a missed operation is refused once a newer operation exists for its target", async () => {
    const old = await plant({ state: "missed", effect: "none" });
    await rows("UPDATE app.post_variants SET schedule_state = 'in_progress' WHERE id = $1", [old.variant]);
    await plant({ state: "pending", of: old });
    const answer = await resolve(old.id, "reschedule");
    expect(answer.error?.code).toBe("SH409");
    expect(await opOf(old.id)).toMatchObject({ state: "missed", resolutions: 0 });
    const [variant] = await rows("SELECT schedule_state FROM app.post_variants WHERE id = $1", [old.variant]);
    expect(variant?.schedule_state).toBe("in_progress");
  });
});

describe("a drop or a reschedule of a post that may have been sent", () => {
  const ABSENCE: [string, "fresh" | "stale" | "other" | "none", boolean][] = [
    ["drop", "fresh", false],
    ["reschedule", "fresh", false],
    ["drop", "stale", true],
    ["drop", "other", true],
    ["reschedule", "none", true],
  ];
  it.each(ABSENCE)("%s with %s absence evidence: refused is %s", async (kind, which, refused) => {
    const planted = await plant({ state: "needs_human", effect: "possible" });
    await ATTEMPT(planted.id, "possible", true);
    const other = await plant({ state: "needs_human", effect: "possible" });
    const [made] = await rows(
      `INSERT INTO app.operation_evidence (workspace_id, operation_id, kind, level, source, observed_at)
       VALUES ($1, $2, 'absent', 'read_back', 'fixture', now() - $3::interval) RETURNING id`,
      [WA, which === "other" ? other.id : planted.id, which === "stale" ? "30 minutes" : "1 minute"],
    );
    const args = which === "none" ? {} : { absence_evidence_id: made?.id };
    const answer = await resolve(planted.id, kind, args);
    if (refused) {
      expect(answer.error?.code).toBe("SH409");
      expect(await opOf(planted.id)).toMatchObject({
        state: "needs_human",
        effect: "possible",
        resolutions: 0,
      });
    } else {
      expect(answer.error).toBeUndefined();
      expect(await opOf(planted.id)).toMatchObject({ state: "cancelled", effect: "none", resolutions: 1 });
    }
  });
});

describe("the permalink of an attestation", () => {
  const LINKS: [string, boolean][] = [
    ["https://example.test/post/1", false],
    ["http://example.test/post/1", false],
    ["javascript:alert(1)", true],
    ["data:text/html,x", true],
    [`https://example.test/${"a".repeat(2040)}`, true],
  ];
  it.each(LINKS)("%s is refused: %s", async (permalink, refused) => {
    const planted = await plant({ state: "needs_human", effect: "possible" });
    const answer = await resolve(planted.id, "attest_published", { permalink });
    if (refused) {
      expect(answer.error?.code).toBe("22023");
      expect(await opOf(planted.id)).toMatchObject({ state: "needs_human", resolutions: 0 });
    } else {
      expect(answer.error).toBeUndefined();
    }
  });
});

describe("a delete beside a publish in flight", () => {
  it("is refused while a publish of the same target is in flight", async () => {
    const planted = await plant({ state: "dispatching", effect: "possible" });
    const fields = {
      variant_id: planted.variant,
      channel_id: channelsOf[WA]?.connected,
      provider_id: "fixture-oauth",
      queue: "publish.fixture-oauth",
      kind: "delete",
      state: "pending",
      due_at: new Date().toISOString(),
      lateness_deadline: new Date(Date.now() + 7_200_000).toISOString(),
      idempotency_marker: `resolutions-${randomUUID()}`,
      requested_by: U.editor,
    };
    const refused = await admin(async (client): Promise<Answer> => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE shoutory_definer");
        await client.query("SELECT app.operation_insert($1::uuid, $2::jsonb, 'U')", [
          WA,
          JSON.stringify(fields),
        ]);
        await client.query("COMMIT");
        return {};
      } catch (error) {
        await client.query("ROLLBACK");
        return { error: error as Answer["error"] };
      }
    });
    expect(refused.error?.code).toBe("23505");
    expect(await opOf(planted.id)).toMatchObject({ state: "dispatching" });
  });
});

describe("who may call the effect SQL", () => {
  type Call = (planted: Planted, foreign: Planted) => [string, unknown[]];
  const quota = "SELECT count(*) FROM app.provider_quota_ledger";
  const CASES: [string, TenantCtx, Call, string][] = [
    ["a user starting an attempt", OWNER, (p) => [START, [WA, p.id, 1, "worker-a", "commit", "{}"]], "42501"],
    [
      "a job of another purpose starting an attempt",
      job("purge_expired"),
      (p) => [START, [WA, p.id, 1, "worker-a", "commit", "{}"]],
      "42501",
    ],
    [
      "a job of the ledger starting an attempt of another workspace",
      LEDGER,
      (_p, f) => [START, [WB, f.id, 1, "worker-a", "commit", "{}"]],
      "unchanged",
    ],
    ["a user finishing an attempt", OWNER, (p) => [FINISH, [WA, p.id, 1, "{}"]], "42501"],
    ["a job resolving", LEDGER, (p) => [RESOLVE, [WA, p.id, "dismiss", "{}"]], "42501"],
    ["a viewer resolving", asUser(U.viewer), (p) => [RESOLVE, [WA, p.id, "dismiss", "{}"]], "42501"],
    ["an outsider resolving", asUser(U.outsider), (p) => [RESOLVE, [WA, p.id, "dismiss", "{}"]], "42501"],
    ["an approver resolving", asUser(U.approver), (p) => [RESOLVE, [WA, p.id, "dismiss", "{}"]], "42501"],
    [
      "the owner of another workspace resolving",
      asUser(U.bOwner),
      (p) => [RESOLVE, [WA, p.id, "dismiss", "{}"]],
      "42501",
    ],
    ["the worker role reading the quota ledger", WORKER, () => [quota, []], "42501"],
    ["the app role reading the quota ledger", OWNER, () => [quota, []], "42501"],
  ];
  it.each(CASES)("refuses %s", async (_name, ctx, call, expected) => {
    const planted = await plant({ state: "needs_human", effect: "possible" });
    const foreign = await plant({ ws: WB, state: "claimed" });
    const [sql, params] = call(planted, foreign);
    const answer = await exec(ctx, sql, params);
    if (expected === "unchanged") {
      expect(answer.error?.code).not.toBe("42883");
      expect(await opOf(foreign.id)).toMatchObject({
        state: "claimed",
        effect: "none",
        attempt_count: 0,
        attempts: 0,
      });
      return;
    }
    expect(answer.error?.code).toBe(expected);
    expect(await opOf(planted.id)).toMatchObject({ state: "needs_human", attempts: 0, resolutions: 0 });
  });
});
