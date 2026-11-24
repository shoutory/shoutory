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
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const WORKER = job([WA]);
const OWNER = asUser(U.owner);
const ADMIN = asUser(U.admin);
const EDITOR = asUser(U.editor);
type Pool = "app" | "worker";
const poolOf = (ctx: TenantCtx): Pool => (ctx.principalKind === "job" ? "worker" : "app");

const channels: Record<string, string> = {};
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    for (const state of ["needs_reconnect", "disconnected", "revoked_by_provider", "connected", "disabled"]) {
      const made = await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
         VALUES ($1, 'fixture-oauth', 'profile', $2, $2, $3) RETURNING id`,
        [WA, `definer-${state}`, state],
      );
      channels[state] = made.rows[0].id;
    }
  });
});
afterAll(() => db.drop());

async function newVariant(author: string = U.editor): Promise<string> {
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
    [WA, author],
  );
  const [made] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'draft') RETURNING id",
    [WA, post?.id, channels.needs_reconnect],
  );
  return made?.id as string;
}

interface Plant {
  state?: string;
  effect?: string | undefined;
  token?: number;
  author?: string;
  channel?: string | undefined;
  lease?: boolean;
  extra?: Record<string, unknown>;
}
const LEASED = new Set(["claimed", "dispatching", "reconciling"]);
async function plant(o: Plant = {}): Promise<string> {
  const state = o.state ?? "claimed";
  const blocked = state === "blocked_reconnect";
  const lease = {
    lease_owner: "worker-a",
    lease_expires_at: new Date(Date.now() + 60_000),
    heartbeat_at: new Date(),
  };
  const given: Record<string, unknown> = {
    workspace_id: WA,
    variant_id: await newVariant(o.author),
    channel_id: o.channel ?? channels.needs_reconnect,
    provider_id: "fixture-oauth",
    queue: "publish.fixture-oauth",
    kind: "publish",
    state,
    effect: o.effect ?? (["published", "provider_accepted"].includes(state) ? "confirmed" : "none"),
    fencing_token: o.token ?? 1,
    last_actor: "S",
    due_at: new Date(),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `definer-${randomUUID()}`,
    requested_by: U.editor,
    blocked_since: blocked ? new Date() : null,
    reason_code: blocked ? "pending" : null,
    ...(o.lease ? lease : {}),
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

const opOf = async (id: string) =>
  (
    await rows(
      `SELECT state, effect, reason_code, last_actor, fencing_token::int AS token, lease_owner, lease_expires_at,
         heartbeat_at, blocked_since, processing_deadline, poll_deadline, step_cursor, external_id, settled_at,
         (SELECT count(*)::int FROM app.operation_evidence e WHERE e.operation_id = o.id) AS evidence
       FROM app.operations o WHERE o.id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;
const outboxOf = (id: string) =>
  rows(
    "SELECT type, workspace_id, payload FROM app.outbox WHERE payload->>'operation_id' = $1 ORDER BY created_at, id",
    [id],
  );

interface Answer {
  rows?: Record<string, unknown>[];
  error?: { code?: string; message?: string } | undefined;
}
const head = (answer: Answer) => answer.rows?.[0];
async function exec(ctx: TenantCtx, sql: string, params: unknown[], pool?: Pool): Promise<Answer> {
  const client = await openTx(db.pool(pool ?? poolOf(ctx)), ctx);
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

interface Ev {
  kind: string;
  level: string;
  outcome_kind: string | null;
  refs: Record<string, unknown>;
}
const E = (kind: string, level: string, outcome_kind: string | null = "post"): Ev => ({
  kind,
  level,
  outcome_kind,
  refs: { source: "fixture", external_id: "ext-1" },
});
const RECEIPT = E("accepted", "receipt");
type Step = [string, string, string];
const STEP: Step = ["claimed", "processing", "W"];
const TRANSITION =
  "SELECT * FROM app.operation_transition($1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7::jsonb)";
const EVIDENCE = "SELECT * FROM app.record_evidence($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)";
const moveArgs = (id: string, token: number, [from, to, actor]: Step, changes = {}, ws: string = WA) => [
  ws,
  id,
  token,
  from,
  to,
  actor,
  JSON.stringify(changes),
];
const evidenceArgs = (id: string, e: Ev, ws = WA) => [
  ws,
  id,
  e.kind,
  e.level,
  e.outcome_kind,
  JSON.stringify(e.refs),
];
const move = (
  ctx: TenantCtx,
  id: string,
  token: number,
  step: Step,
  changes = {},
  ws: string = WA,
  pool?: Pool,
) => exec(ctx, TRANSITION, moveArgs(id, token, step, changes, ws), pool);
const cancel = (ctx: TenantCtx, id: string, ws = WA) =>
  exec(ctx, "SELECT app.operation_cancel($1::uuid, $2::uuid)", [ws, id]);
const evidence = (ctx: TenantCtx, id: string, e: Ev = RECEIPT) => exec(ctx, EVIDENCE, evidenceArgs(id, e));

const INSERT = "SELECT app.operation_insert($1::uuid, $2::jsonb, $3) AS id";
// The insert has no runtime caller, so it runs as the definer role.
const insertAs = (fields: Record<string, unknown>, actor: string): Promise<Answer> =>
  admin(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE shoutory_definer");
      const made = (await client.query(INSERT, [WA, JSON.stringify(fields), actor])).rows;
      await client.query("COMMIT");
      return { rows: made };
    } catch (error) {
      await client.query("ROLLBACK");
      return { error: error as Answer["error"] };
    }
  });
const fieldsOf = async (extra: Record<string, unknown> = {}) => ({
  variant_id: await newVariant(),
  channel_id: channels.needs_reconnect,
  provider_id: "fixture-oauth",
  queue: "publish.fixture-oauth",
  kind: "publish",
  part_index: 0,
  state: "pending",
  due_at: new Date().toISOString(),
  lateness_deadline: new Date(Date.now() + 7_200_000).toISOString(),
  idempotency_marker: `definer-${randomUUID()}`,
  requested_by: U.editor,
  ...extra,
});

describe("a fenced write", () => {
  it("a write with a stale fencing token or a wrong state changes nothing and returns lost_lease", async () => {
    const id = await plant({ token: 3, lease: true });
    const before = await opOf(id);
    for (const [token, step] of [
      [2, STEP],
      [4, STEP],
      [3, ["processing", "retry_wait", "P"]],
    ] as [number, Step][]) {
      const answer = await move(WORKER, id, token, step);
      expect(head(answer), `${token} ${step[0]}`).toMatchObject({ outcome: "lost_lease" });
    }
    expect(await opOf(id)).toEqual(before);
    expect(await outboxOf(id)).toEqual([]);
    expect(head(await move(WORKER, id, 3, STEP))).toMatchObject({ outcome: "moved" });
    expect(await opOf(id)).toMatchObject({ state: "processing", token: 3 });
  });
});

describe("two sessions meet on one operation", () => {
  const MEETINGS: [
    string,
    Plant,
    (id: string) => [string, unknown[]],
    (id: string) => [string, unknown[]],
    object,
  ][] = [
    [
      "two workers with the same token: the first commits, the second returns lost_lease",
      { token: 3, lease: true },
      (id) => [TRANSITION, moveArgs(id, 3, STEP)],
      (id) => [TRANSITION, moveArgs(id, 3, STEP)],
      { state: "processing", token: 3 },
    ],
    [
      "evidence commits first, a worker with the old token returns lost_lease",
      { state: "dispatching", effect: "possible", token: 3, lease: true },
      (id) => [EVIDENCE, evidenceArgs(id, RECEIPT)],
      (id) => [TRANSITION, moveArgs(id, 3, ["dispatching", "published", "W"], { evidence: RECEIPT })],
      { state: "published", token: 4 },
    ],
  ];
  it.each(MEETINGS)(
    "two sessions meet on one operation: %s",
    async (_name, planted, first, second, after) => {
      const id = await plant(planted);
      const answers: Record<number, Record<string, unknown> | undefined> = {};
      const result = await holdThenRace(
        rows,
        await openTx(db.pool("worker"), WORKER),
        await openTx(db.pool("worker"), WORKER),
        async (client, n) => {
          const [sql, params] = (n === 1 ? first : second)(id);
          answers[n] = (await client.query(sql, params)).rows[0];
        },
      );
      expect(result.secondError).toBeUndefined();
      expect(answers[2]).toMatchObject({ outcome: "lost_lease" });
      expect(await opOf(id)).toMatchObject(after);
    },
  );
});

describe("cancel and evidence raise the fencing token", () => {
  const BUMPS: [string, string, (id: string) => Promise<Answer>, Step, Record<string, unknown>][] = [
    ["cancel", "claimed", (id) => cancel(ADMIN, id), ["claimed", "processing", "W"], {}],
  ];
  it.each(BUMPS)(
    "cancel and an evidence write each bump the fencing token and a stale holder's next write changes nothing: %s",
    async (_name, state, act, step, changes) => {
      const id = await plant({
        state,
        effect: state === "dispatching" ? "possible" : "none",
        token: 2,
        lease: true,
      });
      expect((await act(id)).error).toBeUndefined();
      const after = await opOf(id);
      expect(after).toMatchObject({ state: state === "claimed" ? "cancelled" : "published", token: 3 });
      expect(head(await move(WORKER, id, 2, step, changes))).toMatchObject({ outcome: "lost_lease" });
      expect(await opOf(id)).toEqual(after);
    },
  );
});

describe("evidence is not fenced", () => {
  it("record_evidence succeeds after the lease moved to another worker", async () => {
    const id = await plant({ state: "processing", token: 1, lease: true });
    await rows("UPDATE app.operations SET lease_owner = 'worker-b', fencing_token = 2 WHERE id = $1", [id]);
    expect(head(await evidence(job([WA]), id, E("verified", "poll_status")))).toMatchObject({ moved: true });
    expect(await opOf(id)).toMatchObject({
      state: "published",
      effect: "confirmed",
      token: 3,
      lease_owner: null,
      external_id: "ext-1",
      evidence: 1,
    });
  });
});

const SUP = "superseded_after_unknown_outcome";
const EVIDENCE_CASES: [string, string, string, Ev, "moves" | "row" | "refused"][] = [
  ["receipt after a possible effect", "dispatching", "possible", RECEIPT, "moves"],
  ["poll_status in processing", "processing", "none", E("verified", "poll_status"), "moves"],
  ["webhook in provider_accepted", "provider_accepted", "confirmed", E("verified", "webhook"), "moves"],
  ["read_back of a draft", "reconciling", "possible", E("observed", "read_back", "draft_delivered"), "moves"],
  ["receipt in unknown_external_state", "unknown_external_state", "possible", RECEIPT, "moves"],
  ["receipt in needs_human", "needs_human", "possible", RECEIPT, "moves"],
  ["no effect in pending", "pending", "none", RECEIPT, "row"],
  ["kind absent", "dispatching", "possible", E("absent", "read_back"), "row"],
  [
    "outcome scheduled_at_provider",
    "dispatching",
    "possible",
    E("accepted", "receipt", "scheduled_at_provider"),
    "row",
  ],
  ["no outcome", "dispatching", "possible", E("accepted", "receipt", null), "row"],
  ["a published operation", "published", "confirmed", E("verified", "read_back"), "row"],
  ["a failed operation", "failed", "none", RECEIPT, "row"],
  ["a cancelled operation", "cancelled", "none", RECEIPT, "row"],
  ["a missed operation", "missed", "none", RECEIPT, "row"],
  ["a superseded operation", SUP, "possible", E("verified", "read_back"), "row"],
  ["level human", "dispatching", "possible", E("human_confirmed", "human"), "refused"],
];

describe("what evidence moves", () => {
  it.each(EVIDENCE_CASES)(
    "evidence moves only a non-terminal operation with a possible or confirmed effect to published; level human is refused; other kinds and outcomes, terminal and superseded only add the row: %s",
    async (_name, state, effect, ev, expected) => {
      const id = await plant({ state, effect, token: 1 });
      const answer = await evidence(WORKER, id, ev);
      const moved = expected === "moves";
      const types = (await outboxOf(id)).map((row) => row.type);
      if (expected === "refused") {
        expect(answer.error?.code).toBe("22023");
        expect(await opOf(id)).toMatchObject({ state, evidence: 0 });
        return expect(types).toEqual([]);
      }
      expect(head(answer)).toMatchObject({ moved });
      expect(await opOf(id)).toMatchObject({
        state: moved ? "published" : state,
        token: moved ? 2 : 1,
        evidence: 1,
      });
      expect(types).toEqual(
        moved ? ["operation.published"] : state === SUP ? ["operation.late_evidence"] : [],
      );
    },
  );

  it.each([
    ["no source", { external_id: "ext-1" }],
    ["an extra key", { source: "fixture", note: "x" }],
  ])("record_evidence refuses references with %s and writes no row", async (_name, refs) => {
    const id = await plant({ state: "dispatching", effect: "possible" });
    const answer = await evidence(WORKER, id, { ...RECEIPT, refs });
    expect(answer.error?.code).toBe("22023");
    expect(await opOf(id)).toMatchObject({ state: "dispatching", evidence: 0 });
  });
});

describe("a move into published carries its evidence", () => {
  const LEVELS = ["human", "receipt", "poll_status", "webhook", "read_back"];
  const ROWS: [string, string, string, string, string][] = [
    ["from dispatching", "dispatching", "W", "receipt", "possible"],
    ["from provider_accepted", "provider_accepted", "P", "poll_status", "confirmed"],
    ["from reconciling", "reconciling", "R", "read_back", "possible"],
  ];
  it.each(ROWS)(
    "operation_transition into published needs the evidence of its row: %s",
    async (_row, from, actor, level, effect) => {
      const id = await plant({ state: from, effect, token: 2, lease: from !== "provider_accepted" });
      const before = await opOf(id);
      const via = (changes: Record<string, unknown>) =>
        move(WORKER, id, 2, [from, "published", actor], changes);
      const given = [
        {},
        ...LEVELS.filter((l) => l !== level).map((l) => ({ evidence: E("verified", l) })),
        { evidence: E("absent", level) },
        { evidence: E("verified", level, "scheduled_at_provider") },
      ];
      const refused = await Promise.all(given.map(via));
      expect(refused.map((answer) => answer.error?.code)).toEqual(given.map(() => "22023"));
      expect(await opOf(id)).toEqual(before);
      expect(head(await via({ evidence: E("verified", level) }))).toMatchObject({ outcome: "moved" });
      expect(await opOf(id)).toMatchObject({
        state: "published",
        effect: "confirmed",
        external_id: "ext-1",
        evidence: 1,
      });
      expect(await rows("SELECT level FROM app.operation_evidence WHERE operation_id = $1", [id])).toEqual([
        { level },
      ]);
    },
  );
});

interface Refusal {
  name: string;
  state?: string;
  effect?: string;
  ctx?: TenantCtx;
  pool?: Pool;
  ws?: string;
  move?: Step;
  lease?: boolean;
  code: string;
}
const REFUSALS: Refusal[] = [
  ...["S", "U", "X", "E", "Z"].map((actor) => ({
    name: `actor ${actor}`,
    move: [...STEP.slice(0, 2), actor] as Step,
    code: "22023",
  })),
  {
    name: "pending to claimed, the claim",
    state: "pending",
    move: ["pending", "claimed", "W"],
    code: "42501",
  },
  {
    name: "unknown_external_state to reconciling",
    state: "unknown_external_state",
    effect: "possible",
    move: ["unknown_external_state", "reconciling", "R"],
    code: "42501",
  },
  {
    name: "unknown_external_state to needs_human",
    state: "unknown_external_state",
    effect: "possible",
    move: ["unknown_external_state", "needs_human", "R"],
    code: "42501",
  },
  { name: "a move not in the table", state: "pending", move: ["pending", "dispatching", "W"], code: "SH409" },
  {
    name: "published to published",
    state: "published",
    move: ["published", "published", "W"],
    code: "SH409",
  },
  { name: "claimed to claimed", move: ["claimed", "claimed", "W"], code: "SH409" },
  {
    name: "blocked_reconnect to blocked_reconnect",
    state: "blocked_reconnect",
    move: ["blocked_reconnect", "blocked_reconnect", "W"],
    code: "SH409",
  },
  // A move into dispatching is refused here: it runs only through operation_attempt_start.
  { name: "claimed to dispatching with its lease", move: ["claimed", "dispatching", "W"], code: "42501" },
  {
    name: "claimed to dispatching without a lease",
    move: ["claimed", "dispatching", "W"],
    lease: false,
    code: "42501",
  },
  {
    name: "processing to dispatching with its lease",
    state: "processing",
    move: ["processing", "dispatching", "P"],
    code: "42501",
  },
  {
    name: "processing to dispatching without a lease",
    state: "processing",
    move: ["processing", "dispatching", "P"],
    lease: false,
    code: "42501",
  },
  { name: "a job naming a workspace it does not hold", ws: WB, code: "42501" },
  { name: "the app role", pool: "app", code: "42501" },
];
describe("who may run operation_transition and which moves it takes", () => {
  it.each(REFUSALS)(
    "operation_transition refuses an actor outside W, P, R, the claim rows, a foreign workspace, an unlisted move, a call that changes no state, a dispatching move without a lease and the app role: $name",
    async (r) => {
      const state = r.state ?? "claimed";
      const id = await plant({ state, effect: r.effect, token: 3, lease: r.lease ?? LEASED.has(state) });
      const before = await opOf(id);
      const answer = await move(r.ctx ?? WORKER, id, 3, r.move ?? STEP, {}, r.ws, r.pool);
      expect(answer.error?.code).toBe(r.code);
      if (r.pool === "app") expect(answer.error?.message).toMatch(/permission denied/);
      expect(await opOf(id)).toEqual(before);
      expect(await outboxOf(id)).toEqual([]);
    },
  );
});

const SOON = new Date(Date.now() + 600_000).toISOString();
describe("the change keys of operation_transition", () => {
  const KEYS: [string, Record<string, unknown>][] = [
    ["state", { state: "published" }],
    ["fencing_token", { fencing_token: 99 }],
    ["effect", { effect: "none" }],
    ["last_actor", { last_actor: "S" }],
    ["workspace_id", { workspace_id: WB }],
    ["id", { id: randomUUID() }],
    ["variant_id", { variant_id: randomUUID() }],
    ["channel_id", { channel_id: randomUUID() }],
    ["idempotency_marker", { idempotency_marker: "another" }],
    ["requested_by", { requested_by: U.admin }],
    ["settled_at", { settled_at: SOON }],
    ["a lease outside dispatching", { lease_expires_at: SOON }],
    ["a reason in processing", { reason_code: "quota" }],
    ["evidence outside rows 17, 23 and 35", { evidence: RECEIPT }],
  ];
  it.each(KEYS)(
    "operation_transition refuses forbidden and unknown change keys: %s",
    async (_name, changes) => {
      const id = await plant({ token: 3, lease: true });
      const before = await opOf(id);
      expect((await move(WORKER, id, 3, STEP, changes)).error?.code).toBe("22023");
      expect(await opOf(id)).toEqual(before);
    },
  );

  it("operation_transition takes the allowed change keys and clears the lease", async () => {
    const id = await plant({ token: 3, lease: true });
    const allowed = {
      processing_deadline: SOON,
      next_check_at: SOON,
      step_cursor: "await_processing",
      provider_refs: { upload: "u-1" },
    };
    expect(head(await move(WORKER, id, 3, STEP, allowed))).toMatchObject({ outcome: "moved" });
    expect(await opOf(id)).toMatchObject({
      state: "processing",
      step_cursor: "await_processing",
      lease_owner: null,
    });
    expect(new Date((await opOf(id)).processing_deadline as string).toISOString()).toBe(SOON);
    const [kept] = await rows("SELECT next_check_at, provider_refs FROM app.operations WHERE id = $1", [id]);
    expect(new Date(kept?.next_check_at).toISOString()).toBe(SOON);
    expect(kept?.provider_refs).toEqual({ upload: "u-1" });
  });
});

describe("operation_insert", () => {
  const NOW = new Date().toISOString();
  const TAKEN: [string, string, Record<string, unknown>][] = [
    ["S pending", "S", {}],
    ["U pending", "U", {}],
    ["S missed", "S", { state: "missed" }],
    ["S paused", "S", { state: "paused", reason_code: "channel_disabled" }],
    ["S blocked_reconnect", "S", { state: "blocked_reconnect", blocked_since: NOW, reason_code: "pending" }],
  ];
  it.each(TAKEN)(
    "operation_insert takes %s and writes the actor, token 0, effect none and no outbox row",
    async (_name, actor, extra) => {
      const answer = await insertAs(await fieldsOf(extra), actor);
      const id = head(answer)?.id as string;
      expect(answer.error).toBeUndefined();
      expect(await opOf(id)).toMatchObject({ last_actor: actor, token: 0, effect: "none" });
      expect(await outboxOf(id)).toEqual([]);
    },
  );

  const ACTORS = ["W", "P", "R", "E", "X"].map((a): [string, string, Record<string, unknown>, string] => [
    `actor ${a}`,
    a,
    {},
    "22023",
  ]);
  const REFUSED: [string, string, Record<string, unknown>, string][] = [
    ...ACTORS,
    ["an unknown key", "S", { bogus: 1 }, "22023"],
    ["a reply target", "S", { reply_target_id: randomUUID() }, "22023"],
    ["a moderation target", "S", { moderation_target_id: randomUUID() }, "22023"],
    ["an effect", "S", { effect: "possible" }, "22023"],
    ["a token", "S", { fencing_token: 5 }, "22023"],
    ["a last_actor", "S", { last_actor: "W" }, "22023"],
    ["U into missed", "U", { state: "missed" }, "SH409"],
    ["S into dispatching", "S", { state: "dispatching" }, "SH409"],
  ];
  it.each(REFUSED)(
    "operation_insert refuses W, P, R, E and X, unknown keys and unlisted moves: %s",
    async (_name, actor, extra, code) => {
      expect((await insertAs(await fieldsOf(extra), actor)).error?.code).toBe(code);
    },
  );

  it.each([
    [EDITOR, "app"],
    [WORKER, "worker"],
  ] as const)("no runtime role can run operation_insert: %#", async (ctx, pool) => {
    const answer = await exec(ctx, INSERT, [WA, JSON.stringify(await fieldsOf()), "S"], pool);
    expect(answer.error?.code).toBe("42501");
    expect(answer.error?.message).toMatch(/permission denied/);
  });
});

describe("the restore reason of a blocked operation", () => {
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  const SOURCES: [string, string, Plant, string, string | undefined][] = [
    ["claimed", "W", { lease: true }, "pending", undefined],
    [
      "processing",
      "P",
      { lease: true, extra: { processing_deadline: FUTURE } },
      "pending",
      "processing_deadline",
    ],
    ["provider_accepted", "P", { extra: { poll_deadline: FUTURE } }, "provider_accepted", "poll_deadline"],
    ["unknown_external_state", "W", { effect: "possible" }, "unknown_external_state", undefined],
    ["reconciling", "R", { effect: "possible", lease: true }, "unknown_external_state", undefined],
  ];
  it.each(SOURCES)(
    "a move to blocked_reconnect restores the reason of its source, keeps the effect and the parked deadlines, clears the lease: %s",
    async (source, actor, planted, reason, parked) => {
      const id = await plant({ ...planted, state: source, token: 2 });
      const before = await opOf(id);
      expect(head(await move(WORKER, id, 2, [source, "blocked_reconnect", actor]))).toMatchObject({
        outcome: "moved",
      });
      const after = await opOf(id);
      expect(after).toMatchObject({
        state: "blocked_reconnect",
        reason_code: reason,
        effect: before.effect,
        token: 2,
      });
      expect(after).toMatchObject({ lease_owner: null, lease_expires_at: null, heartbeat_at: null });
      expect(after.blocked_since).not.toBeNull();
      if (parked) expect(after[parked]).toEqual(before[parked]);
    },
  );

  it.each(["connected", "disabled"])(
    "a move to blocked_reconnect is refused while the channel is %s",
    async (open) => {
      const id = await plant({ state: "claimed", token: 2, lease: true, channel: channels[open] });
      const before = await opOf(id);
      expect((await move(WORKER, id, 2, ["claimed", "blocked_reconnect", "W"])).error?.code).toBe("SH409");
      expect(await opOf(id)).toEqual(before);
    },
  );
});

describe("operation_cancel", () => {
  const CASES: [string, TenantCtx, Plant, string | undefined][] = [
    ["an Admin", ADMIN, {}, undefined],
    ["an Owner", OWNER, {}, undefined],
    ["the Editor who wrote the post", EDITOR, {}, undefined],
    ["an Editor who did not write it", EDITOR, { author: U.admin }, "42501"],
    ["an Approver", asUser(U.approver), {}, "42501"],
    ["a Viewer", asUser(U.viewer), {}, "42501"],
    ["a non-member", asUser(U.outsider), {}, "42501"],
    ["a job principal", WORKER, {}, "42501"],
    ["effect possible", ADMIN, { state: "claimed", effect: "possible" }, "SH409"],
    ["effect confirmed", ADMIN, { effect: "confirmed" }, "SH409"],
    ["a cancelled operation", ADMIN, { state: "cancelled" }, "SH409"],
  ];
  it.each(CASES)(
    "cancel is refused for effect possible, a terminal operation, an Approver, a Viewer and an Editor who is not the author, and allowed for an Admin, an Owner and the author: %s",
    async (_name, ctx, planted, code) => {
      const id = await plant({ state: "pending", ...planted });
      const before = await opOf(id);
      const answer = await cancel(ctx, id);
      if (!code) {
        expect(answer.error).toBeUndefined();
        return expect(await opOf(id)).toMatchObject({
          state: "cancelled",
          last_actor: "U",
          token: Number(before.token) + 1,
        });
      }
      expect(answer.error?.code).toBe(code);
      expect(await opOf(id)).toEqual(before);
      expect(await outboxOf(id)).toEqual([]);
    },
  );
});

describe("what operation_cancel clears and refuses", () => {
  it.each([
    ["claimed", { lease: true }],
    ["processing", { lease: true, extra: { processing_deadline: SOON } }],
    ["blocked_reconnect", { extra: { poll_deadline: SOON } }],
  ] as [string, Plant][])(
    "cancel clears the lease, the deadlines and the blocked columns: %s",
    async (state, extra) => {
      const id = await plant({ state, ...extra });
      expect((await cancel(ADMIN, id)).error).toBeUndefined();
      expect(await opOf(id)).toMatchObject({
        state: "cancelled",
        reason_code: null,
        lease_owner: null,
        blocked_since: null,
        processing_deadline: null,
        poll_deadline: null,
      });
    },
  );

  it.each([["another workspace"], ["an unknown id"]])(
    "cancel of a foreign or unknown id touches nothing: %s",
    async (which) => {
      const id = await plant({ state: "pending" });
      const answer =
        which === "an unknown id" ? await cancel(ADMIN, randomUUID()) : await cancel(ADMIN, id, WB);
      expect(answer.error?.code).toBe("42501");
      expect(await opOf(id)).toMatchObject({ state: "pending", token: 1 });
    },
  );
});

type Run = () => Promise<[string, Answer]>;
const viaPlant =
  (planted: Plant, call: (id: string) => Promise<Answer>): Run =>
  async () => {
    const id = await plant(planted);
    return [id, await call(id)];
  };
const DISPATCHING: Plant = { state: "dispatching", effect: "possible", lease: true };
const PROCESSING = viaPlant({ lease: true }, (id) => move(WORKER, id, 1, STEP));
const PUBLISHING = viaPlant(DISPATCHING, (id) =>
  move(WORKER, id, 1, ["dispatching", "published", "W"], { evidence: RECEIPT }),
);
const CANCELLING = viaPlant({ state: "pending" }, (id) => cancel(ADMIN, id));
const EVIDENCING = viaPlant(DISPATCHING, (id) => evidence(WORKER, id));
const INSERTING: Run = async () => {
  const made = await insertAs(await fieldsOf(), "U");
  return [made.rows?.[0]?.id as string, made];
};

// The planted row says S, so a definer that forgot last_actor would leave S, which no move of these rows names.
describe("every ledger definer writes last_actor", () => {
  it.each([
    ["transition", "W", PROCESSING],
    ["cancel", "U", CANCELLING],
    ["evidence", "E", EVIDENCING],
    ["insert", "U", INSERTING],
  ] as [string, string, Run][])("every ledger definer writes last_actor: %s", async (_name, actor, run) => {
    const [id, answer] = await run();
    expect(answer.error).toBeUndefined();
    expect(await opOf(id)).toMatchObject({ last_actor: actor });
  });
});

describe("every ledger definer writes its outbox row", () => {
  it.each([
    ["a worker move", "operation.processing", PROCESSING],
    ["a worker move into published", "operation.published", PUBLISHING],
    ["a cancel", "operation.cancelled", CANCELLING],
  ] as [string, string, Run][])(
    "each moving definer writes its outbox row with ids and states only: %s",
    async (_name, type, run) => {
      const [id, answer] = await run();
      expect(answer.error).toBeUndefined();
      const out = await outboxOf(id);
      expect(out.map((row) => [row.type, row.workspace_id])).toEqual([[type, WA]]);
      expect(out[0]?.payload).toMatchObject({ operation_id: id });
    },
  );

  it.each([
    ["a stale token", viaPlant({ lease: true, token: 3 }, (id) => move(WORKER, id, 2, STEP))],
    [
      "a cancel with a possible effect",
      viaPlant({ state: "claimed", effect: "possible" }, (id) => cancel(ADMIN, id)),
    ],
    [
      "evidence at level human",
      viaPlant(DISPATCHING, (id) => evidence(WORKER, id, E("human_confirmed", "human"))),
    ],
  ] as [string, Run][])("a refused or lost call writes no outbox row: %s", async (_name, run) => {
    const [id] = await run();
    expect(await outboxOf(id)).toEqual([]);
    // The same operation moves and writes its row, so the empty answer is not the table being unreadable.
    const [moved] = await PROCESSING();
    expect(await outboxOf(moved)).toHaveLength(1);
  });

  // A call that is answered, moved or lost, hands the purpose back: a caller that goes on in its transaction is not left
  // under the purpose of a ledger writer.
  it.each([
    ["a moved call", 1],
    ["a lost call", 2],
  ])("app.job_purpose is restored after %s", async (_name, token) => {
    const id = await plant({ lease: true, token: 1 });
    const client = await openTx(db.pool("worker"), WORKER);
    try {
      const answer = (await client.query(TRANSITION, moveArgs(id, token, STEP))).rows[0];
      expect(answer?.outcome).toBe(token === 1 ? "moved" : "lost_lease");
      const after = await client.query(
        "SELECT coalesce(current_setting('app.job_purpose', true), '') AS purpose",
      );
      expect(after.rows[0]).toEqual({ purpose: "" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

const WRITERS = [
  "admit_due_targets",
  "claim_operations",
  "claim_polls",
  "claim_reconciles",
  "heartbeat",
  "ledger_add_evidence",
  "ledger_due_move",
  "operation_attempt_finish",
  "operation_attempt_start",
  "operation_cancel",
  "operation_insert",
  "operation_media_pin",
  "operation_record_progress",
  "operation_transition",
  "operations_usage",
  "record_evidence",
  "resolve_operation",
  "sweep_due_moves",
  "sweep_expired_leases",
];
describe("the ledger tables are written only by ledger definers", () => {
  it("ledger tables are written only by ledger definer functions", async () => {
    const writers = await rows(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(only\\s+)?(app\\.)?(operations|operation_evidence|operation_attempts|operation_resolutions|operation_media|usage_reservations)\\y'
        ORDER BY p.proname`,
    );
    expect(writers.map((row) => row.proname)).toEqual(WRITERS);
    expect(writers.filter((row) => row.owner !== "shoutory_definer")).toEqual([]);
    // A worker that skips the definers is refused by the grants, not by a policy.
    const direct = await exec(WORKER, "UPDATE app.operations SET state = 'cancelled' WHERE id = $1", [
      randomUUID(),
    ]);
    expect(direct.error?.code).toBe("42501");
  });

  it("the definer role may update only the operation columns the ledger definers write", async () => {
    const granted = await rows(
      `SELECT column_name FROM information_schema.role_column_grants
        WHERE grantee = 'shoutory_definer' AND table_schema = 'app' AND table_name = 'operations'
          AND privilege_type = 'UPDATE' ORDER BY column_name`,
    );
    expect(granted.map((row) => row.column_name)).toEqual(
      [
        "attempt_count",
        "blocked_since",
        "effect",
        "external_id",
        "fencing_token",
        "heartbeat_at",
        "last_actor",
        "lateness_deadline",
        "lease_expires_at",
        "lease_owner",
        "next_attempt_at",
        "next_check_at",
        "poll_deadline",
        "processing_deadline",
        "provider_refs",
        "queue",
        "reason_code",
        "state",
        "step_cursor",
        "superseded_by_operation_id",
        "unverified_until",
      ].sort(),
    );
  });
});
