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
import { seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();
const REFUSED_ROWS = 500;

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
async function ledger(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = await openTx(db.pool("worker"), LEDGER);
  try {
    const answer = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return answer;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Prov {
  provider: string;
  channel: string;
  workspace: string;
}
async function newProvider(prefix: string, workspace: string = WA): Promise<Prov> {
  const provider = `${prefix}-${randomUUID().slice(0, 8)}`;
  const [made] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
    [workspace, provider],
  );
  return { provider, channel: made?.id as string, workspace };
}

interface Bulk {
  state: string;
  variant?: { state: string; dueIn: number };
  at?: Record<string, number>;
  extra?: Record<string, unknown>;
  effect?: string;
}
// One statement plants `count` operations, each on a post and target of its own.
async function plantMany(p: Prov, count: number, o: Bulk): Promise<void> {
  const at = { due_at: -120, next_attempt_at: -60, lateness_deadline: 7200, ...o.at };
  const fixed: Record<string, unknown> = {
    provider_id: p.provider,
    queue: `publish.${p.provider}`,
    kind: "publish",
    state: o.state,
    effect: o.effect ?? "none",
    fencing_token: 1,
    last_actor: "S",
    requested_by: U.editor,
    lease_seconds: 60,
    ...o.extra,
  };
  const names = Object.keys(fixed);
  const atNames = Object.keys(at);
  const variant = o.variant ?? { state: "in_progress", dueIn: -120 };
  const params = [
    p.workspace,
    U.editor,
    p.channel,
    variant.state,
    variant.dueIn,
    ...Object.values(fixed),
    ...Object.values(at),
  ];
  const fixedAt = (i: number) => `$${6 + i}`;
  const atAt = (i: number) => `now() + make_interval(secs => $${6 + names.length + i}::float8)`;
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `WITH ids AS (SELECT uuidv7() AS pid, uuidv7() AS vid FROM generate_series(1, ${count})),
         ps AS (INSERT INTO app.posts (id, workspace_id, author_kind, author_id, status)
           SELECT pid, $1, 'user', $2, 'scheduled' FROM ids),
         vs AS (INSERT INTO app.post_variants (id, workspace_id, post_id, channel_id, schedule_state, due_at)
           SELECT vid, $1, pid, $3, $4, now() + make_interval(secs => $5::float8) FROM ids)
       INSERT INTO app.operations (workspace_id, variant_id, channel_id, idempotency_marker, ${names.join(", ")}, ${atNames.join(", ")})
       SELECT $1, vid, $3, 'skip-' || uuidv7()::text, ${names.map((_, i) => fixedAt(i)).join(", ")}, ${atNames.map((_, i) => atAt(i)).join(", ")}
         FROM ids`,
      params,
    );
    await client.query("COMMIT");
  });
}

const one = async (p: Prov, o: Bulk): Promise<string> => {
  await plantMany(p, 1, o);
  return String((await rows("SELECT id FROM app.operations WHERE provider_id = $1", [p.provider]))[0]?.id);
};
const stateOf = async (id: string) =>
  (await rows("SELECT state FROM app.operations WHERE id = $1", [id]))[0]?.state;

interface Refused {
  id: string;
  reason: string;
}
const admit = (p: Prov, limit = 500) =>
  ledger("SELECT * FROM app.admit_due_targets($1, $2::jsonb)", [
    limit,
    JSON.stringify({
      [p.provider]: { margin_seconds: 300, lease_seconds: { publish: 60, edit: 60, delete: 60 } },
    }),
  ]);

describe("a target the index refuses", () => {
  it("is skipped for a while and 500 refused rows do not block a fresh due target (admission)", async () => {
    const p = await newProvider("skip-admit");
    await plantMany(p, REFUSED_ROWS, { state: "pending", variant: { state: "scheduled", dueIn: -50 } });
    const [post] = await rows(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
      [WA, U.editor],
    );
    await rows(
      `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, due_at)
       VALUES ($1, $2, $3, 'scheduled', now() - interval '5 seconds')`,
      [WA, post?.id, p.channel],
    );
    const first = await admit(p);
    const second = await admit(p);
    expect(second.filter((row) => row.state !== "refused").length).toBe(1);
    const refused = first.filter((row) => row.state === "refused");
    expect(refused.length).toBe(REFUSED_ROWS);
    expect(refused.every((row) => row.operation_id === null && row.queue === null)).toBe(true);
    expect(refused.every((row) => row.variant_id !== null && typeof row.reason === "string")).toBe(true);
    expect(second.filter((row) => row.state === "refused").length).toBe(0);
    const marked = await rows(
      "SELECT count(*)::int AS n FROM app.post_variants WHERE channel_id = $1 AND admit_skip_until > now()",
      [p.channel],
    );
    expect(marked[0]?.n).toBe(REFUSED_ROWS);
    await rows(
      "UPDATE app.post_variants SET admit_skip_until = now() - interval '1 second' WHERE channel_id = $1",
      [p.channel],
    );
    expect((await admit(p)).filter((row) => row.state === "refused").length).toBe(REFUSED_ROWS);
  }, 60_000);
});

const live = (...ps: Prov[]) =>
  JSON.stringify(Object.fromEntries(ps.map((p) => [p.provider, { max_attempts: 3 }])));
const sweep = async (map: string) =>
  (await ledger("SELECT app.sweep_due_moves($1::jsonb) AS r", [map]))[0]?.r as {
    moved: number;
    refused: Refused[];
  };

// [the arm, the plant of a row whose move is refused and of the fresh row that moves]
const ARMS: [string, Bulk][] = [
  ["attempts exhausted", { state: "retry_wait", at: { next_attempt_at: 600 }, extra: { attempt_count: 3 } }],
  [
    "an unverified horizon",
    { state: "unknown_external_state", effect: "possible", at: { unverified_until: -10 } },
  ],
  ["a reconnected channel", { state: "paused", extra: { reason_code: "channel_disabled" } }],
  ["a lateness deadline", { state: "pending", at: { lateness_deadline: -10 } }],
  ["a processing deadline", { state: "processing", at: { processing_deadline: -10 } }],
];
const PROBE = `
  CREATE FUNCTION public.refuse_probe() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.provider_id LIKE 'skip-refused-%' THEN
      RAISE EXCEPTION 'the probe refuses this move' USING ERRCODE = 'SH409';
    END IF;
    RETURN NEW;
  END
  $$`;

describe("a row the guard refuses", () => {
  it.each(ARMS)(
    "a row the guard refuses is skipped for a while and 500 refused rows do not block a fresh due row (%s)",
    async (_arm, plant) => {
      const [bad, fine] = [await newProvider("skip-refused"), await newProvider("skip-fine")];
      await ledger("SELECT app.sweep_due_moves($1::jsonb)", [live(bad, fine)]);
      await rows(PROBE);
      await rows(
        "CREATE TRIGGER a_refuse_probe BEFORE UPDATE ON app.operations FOR EACH ROW EXECUTE FUNCTION public.refuse_probe()",
      );
      try {
        await plantMany(bad, REFUSED_ROWS, plant);
        const good = await one(fine, plant);
        const before = await stateOf(good);
        const first = await sweep(live(bad, fine));
        expect(await stateOf(good)).toBe(before);
        const second = await sweep(live(bad, fine));
        expect(await stateOf(good)).not.toBe(before);
        expect(first.refused.length).toBe(REFUSED_ROWS);
        expect(first.refused.every((row) => typeof row.reason === "string")).toBe(true);
        expect(second.refused.length).toBe(0);
        const marked = await rows(
          "SELECT count(*)::int AS n FROM app.operations WHERE provider_id = $1 AND sweep_skip_until > now()",
          [bad.provider],
        );
        expect(marked[0]?.n).toBe(REFUSED_ROWS);
        await rows(
          "UPDATE app.operations SET sweep_skip_until = now() - interval '1 second' WHERE provider_id = $1",
          [bad.provider],
        );
        expect((await sweep(live(bad, fine))).refused.length).toBe(REFUSED_ROWS);
      } finally {
        await rows("DROP TRIGGER a_refuse_probe ON app.operations");
        await rows("DROP FUNCTION public.refuse_probe()");
      }
    },
    120_000,
  );
});

interface Planted {
  state: string;
  actor: string;
  token: number;
  effect: string;
  deadline: string | null;
  lease: string | null;
  attempts: number;
  next_attempt_due: boolean | null;
}
const factsOf = async (id: string) =>
  (
    await rows(
      `SELECT state, last_actor AS actor, fencing_token::int AS token, effect, processing_deadline AS deadline,
         lease_owner AS lease, attempt_count AS attempts, next_attempt_at <= clock_timestamp() AS next_attempt_due
       FROM app.operations WHERE id = $1`,
      [id],
    )
  )[0] as unknown as Planted;

const PASSED = { processing_deadline: -10 };
const EXPIRED = { extra: { lease_owner: "poller-gone" }, at: { ...PASSED, lease_expires_at: -5 } };

describe("a processing row past its deadline", () => {
  it.each([
    [
      "a poller died holding the lease and attempts remain",
      { ...EXPIRED, extra: { ...EXPIRED.extra, attempt_count: 1 } },
      "retry_wait",
      "X",
      2,
    ],
    ["no poller ran and attempts remain", { at: PASSED, extra: { attempt_count: 0 } }, "retry_wait", "X", 2],
    ["attempts are exhausted", { at: PASSED, extra: { attempt_count: 3 } }, "failed", "S", 1],
    ["the timeout is the last attempt left", { at: PASSED, extra: { attempt_count: 2 } }, "failed", "S", 1],
  ] as [string, Partial<Bulk>, string, string, number][])(
    "the sweep moves it with effect none when %s, counts a retry as an attempt, and a second sweep changes nothing",
    async (_arm, plant, state, actor, token) => {
      const p = await newProvider("sweep-processing");
      const id = await one(p, { state: "processing", ...plant });
      const used = Number(plant.extra?.attempt_count);
      await sweep(live(p));
      expect(await factsOf(id)).toMatchObject({
        state,
        actor,
        token,
        effect: "none",
        deadline: null,
        lease: null,
        attempts: state === "retry_wait" ? used + 1 : used,
      });
      if (state === "retry_wait") expect((await factsOf(id)).next_attempt_due).toBe(true);
      const [event] = await rows("SELECT type FROM app.outbox WHERE payload ->> 'operation_id' = $1", [id]);
      expect(event?.type).toBe(`operation.${state}`);
      await sweep(live(p));
      expect((await factsOf(id)).token).toBe(token);
    },
  );
});

describe("a row the processing sweep must not touch", () => {
  it.each([
    ["the deadline is ahead", { state: "processing", at: { processing_deadline: 600 } }, true],
    [
      "a poller still holds the lease",
      {
        state: "processing",
        extra: { lease_owner: "poller-live" },
        at: { ...PASSED, lease_expires_at: 60 },
      },
      true,
    ],
    [
      "the row is blocked for a reconnect",
      {
        state: "blocked_reconnect",
        extra: { reason_code: "pending" },
        at: { ...PASSED, blocked_since: -30 },
      },
      true,
    ],
    ["its provider is not live", { state: "processing", at: PASSED }, false],
  ] as [string, Bulk, boolean][])("the sweep leaves it alone when %s", async (_arm, plant, providerLive) => {
    const p = await newProvider("sweep-processing-keep");
    const id = await one(p, plant);
    const before = await factsOf(id);
    await sweep(providerLive ? live(p) : "{}");
    expect(await factsOf(id)).toEqual(before);
  });
});
