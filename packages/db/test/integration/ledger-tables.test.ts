import { randomUUID } from "node:crypto";
import { LEDGER_ACTORS, LEDGER_STATES, LEDGER_TRANSITIONS, TERMINAL_STATES } from "@shoutory/core/ledger";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { OA, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

// Security floor of migration 0019, the publishing ledger tables: the seed is the transition table, the trigger refuses
// every move that table does not list, one operation per target holds the slot, a published part is settled once, and
// the definer role holds only what the triggers and the retention need. Rows are planted as the superuser, and a row in
// a given state is planted with the triggers off (`session_replication_role = replica`) so that its state is not the
// result of a move. The columns an insert names, the error codes and the table and column names are the contract the
// migration must meet; nothing sleeps.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

let channel: string;
let counter = 0;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    channel = (
      await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name)
         VALUES ($1, 'fixture-oauth', 'profile', 'ledger-channel', 'ledger-channel') RETURNING id`,
        [WA],
      )
    ).rows[0].id;
  });
});
afterAll(() => db.drop());

// A post with one variant, so every scenario has its own target (the variant is what an operation publishes to).
async function newVariant(settled = false): Promise<string> {
  return admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
        [WA, U.editor],
      )
    ).rows[0].id;
    const made = await client.query(
      "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, $4) RETURNING id",
      [WA, post, channel, settled ? "settled" : "draft"],
    );
    return made.rows[0].id as string;
  });
}

// The columns that belong to a state only: a blocked operation records when it was blocked and what it restores to.
const scopedValues = (state: string) =>
  state === "blocked_reconnect"
    ? { blocked_since: new Date(), reason_code: "pending" }
    : { blocked_since: null, reason_code: null };

interface Made {
  variant: string;
  state: string;
  actor?: string;
  kind?: string;
  part?: number;
  supersedes?: string;
  target?: { variant: string | null; reply: string | null };
  /** Columns to set beyond (or instead of) the ones the state implies. */
  extra?: Record<string, unknown>;
}
// One INSERT with every column the contract requires; the caller chooses what the test is about.
async function insertOp(client: Client, made: Made): Promise<string> {
  const target = made.target ?? { variant: made.variant, reply: null };
  const given: Record<string, unknown> = {
    workspace_id: WA,
    variant_id: target.variant,
    reply_target_id: target.reply,
    channel_id: channel,
    provider_id: "fixture-oauth",
    queue: "publish.fixture-oauth",
    kind: made.kind ?? "publish",
    part_index: made.part ?? 0,
    state: made.state,
    last_actor: made.actor ?? "S",
    due_at: new Date(),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `ledger-${++counter}-${randomUUID()}`,
    requested_by: U.editor,
    supersedes_operation_id: made.supersedes ?? null,
    effect: ["published", "provider_accepted"].includes(made.state) ? "confirmed" : "none",
    ...scopedValues(made.state),
    ...made.extra,
  };
  const names = Object.keys(given);
  const found = await client.query(
    `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING id`,
    Object.values(given),
  );
  return found.rows[0].id as string;
}

const insert = (made: Made) => admin((client) => insertOp(client, made));
// A row in a given state, as if earlier moves had led there.
const plant = (made: Made) =>
  admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const id = await insertOp(client, made);
    await client.query("COMMIT");
    return id;
  });

describe("the seed of the transition table", () => {
  it("holds exactly the 51 OL transition rows, ids 1..51 contiguous, and equals the core table", async () => {
    const seeded = await rows(
      "SELECT row_no, from_state, to_state, actor, guard, bumps_fence FROM app.ledger_transitions",
    );
    const numbers = [...new Set(seeded.map((row) => row.row_no as number))].sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    const text = (row: Record<string, unknown>) =>
      [row.row_no, row.from_state, row.to_state, row.actor, row.guard, row.bumps_fence].join("|");
    const wanted = LEDGER_TRANSITIONS.map((t) =>
      [t.row, t.from, t.to, t.actor, t.guard, t.bumpsFence].join("|"),
    );
    expect(seeded.map(text).sort()).toEqual(wanted.sort());
  });
});

// The moves of the core table, and whether any row for the triple raises the fencing token (two rows may share a
// triple; a move that either row says bumps, bumps).
const KEY = (from: string, to: string, actor: string) => `${from}|${to}|${actor}`;
const ALLOWED = new Map<string, boolean>();
for (const move of LEDGER_TRANSITIONS) {
  const key = KEY(move.from, move.to, move.actor);
  ALLOWED.set(key, (ALLOWED.get(key) ?? false) || move.bumpsFence);
}
const TERMINAL = new Set<string>(TERMINAL_STATES);

interface Seen {
  state: string;
  fencing_token: string;
  settled_at: Date | null;
  last_actor: string;
}
const SELECT_ROW =
  "SELECT state, fencing_token::text, settled_at, last_actor FROM app.operations WHERE id = $1";

// One pair, tried inside a savepoint that is always rolled back: what the statement answered and what it left.
async function attempt(client: Client, run: () => Promise<Seen | undefined>) {
  await client.query("SAVEPOINT pair");
  try {
    return { ok: true as const, seen: await run() };
  } catch (error) {
    return { ok: false as const, code: (error as { code?: string }).code };
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT pair");
  }
}

// What a pair must leave: a move of the table is taken (the new state, the token the seed row asks for, a settled time
// exactly when the state is terminal), any other is refused with SH409. A mismatch names both.
function problems(
  from: string,
  to: string,
  actor: string,
  before: string,
  outcome: Awaited<ReturnType<typeof attempt>>,
) {
  const bumps = ALLOWED.get(KEY(from, to, actor));
  const wanted =
    bumps === undefined
      ? "SH409"
      : `${to} token ${Number(before) + (bumps ? 1 : 0)} settled ${TERMINAL.has(to)}`;
  const seen = outcome.ok ? outcome.seen : undefined;
  const got = outcome.ok
    ? `${seen?.state} token ${Number(seen?.fencing_token)} settled ${seen?.settled_at != null}`
    : outcome.code;
  return got === wanted ? [] : [`${from} -> ${to} by ${actor} gave ${got}, wanted ${wanted}`];
}

async function tryUpdate(client: Client, id: string, to: string, actor: string): Promise<Seen | undefined> {
  const scoped = scopedValues(to);
  await client.query(
    "UPDATE app.operations SET state = $2, last_actor = $3, blocked_since = $4, reason_code = $5 WHERE id = $1",
    [id, to, actor, scoped.blocked_since, scoped.reason_code],
  );
  return (await client.query(SELECT_ROW, [id])).rows[0];
}

interface Pair {
  from: string;
  to: string;
  actor: string;
  variant: string;
  /** The planted row the move is tried on; none for an insert. */
  planted: string | undefined;
  before: Seen | undefined;
}

// One move, tried on the planted row (or as an insert) and rolled back: what it answered, and that the row is as it was.
async function tryPair(client: Client, pair: Pair): Promise<string[]> {
  const { from, to, actor, variant, planted, before } = pair;
  const outcome = await attempt(client, async () =>
    planted
      ? tryUpdate(client, planted, to, actor)
      : (await client.query(SELECT_ROW, [await insertOp(client, { variant, state: to, actor })])).rows[0],
  );
  const found = problems(from, to, actor, before?.fencing_token ?? "0", outcome);
  const after = planted ? (await client.query(SELECT_ROW, [planted])).rows[0] : undefined;
  if (JSON.stringify(after) !== JSON.stringify(before))
    found.push(`${from} -> ${to} by ${actor} changed the row`);
  return found;
}

describe("the transition trigger", () => {
  it.each(["none", ...LEDGER_STATES])(
    "from %s: every (from, to, actor) of the core table is allowed and every other pair, inserts included, is refused with the row unchanged",
    async (from) => {
      const variant = await newVariant();
      const planted = from === "none" ? undefined : await plant({ variant, state: from });
      const found = await admin(async (client) => {
        const before = planted ? (await client.query(SELECT_ROW, [planted])).rows[0] : undefined;
        const wrong: string[] = [];
        // Every pair runs in a savepoint of this one transaction, which is rolled back at the end.
        await client.query("BEGIN");
        for (const to of LEDGER_STATES.filter((state) => state !== from)) {
          for (const actor of LEDGER_ACTORS) {
            wrong.push(...(await tryPair(client, { from, to, actor, variant, planted, before })));
          }
        }
        await client.query("ROLLBACK");
        return wrong;
      });
      expect(found).toEqual([]);
      if (!planted)
        expect(await rows("SELECT id FROM app.operations WHERE variant_id = $1", [variant])).toEqual([]);
    },
    120_000,
  );
});

// The effect and the token. Only the rows that prove nothing happened (19, 20, 21, 24, 36, 42, 44) may bring an effect
// that is possible or confirmed back to none, no statement that leaves the state alone may, a move into published or
// provider_accepted confirms the effect, the token never goes down, and an insert starts with no effect and token 0.
const RESET_ROWS = new Set([19, 20, 21, 24, 36, 42, 44]);
const RESETS = new Set(
  LEDGER_TRANSITIONS.filter((move) => RESET_ROWS.has(move.row)).map((move) =>
    KEY(move.from, move.to, move.actor),
  ),
);
const CONFIRMING = new Set(["published", "provider_accepted"]);
const EFFECT_ROW = "SELECT state, effect, fencing_token::text AS token FROM app.operations WHERE id = $1";
type After = { code?: string | undefined; state?: string; effect?: string; token?: string };

// One statement in a savepoint that is rolled back: the error code it gave, or the row it left.
async function tried(client: Client, id: string, sql: string, params: unknown[]): Promise<After> {
  await client.query("SAVEPOINT effect");
  try {
    await client.query(sql, params);
    return (await client.query(EFFECT_ROW, [id])).rows[0];
  } catch (error) {
    return { code: (error as { code?: string }).code };
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT effect");
  }
}

const MOVE_SQL =
  "UPDATE app.operations SET state = $2, last_actor = $3, blocked_since = $4, reason_code = $5";
async function move(client: Client, id: string, to: string, actor: string, resetEffect: boolean) {
  const scoped = scopedValues(to);
  const sql = `${MOVE_SQL}${resetEffect ? ", effect = 'none'" : ""} WHERE id = $1`;
  return tried(client, id, sql, [id, to, actor, scoped.blocked_since, scoped.reason_code]);
}

// Every move out of `from`, once with the effect reset and once without it.
async function effectProblems(client: Client, id: string, from: string): Promise<string[]> {
  const found: string[] = [];
  const moves = new Map(
    LEDGER_TRANSITIONS.filter((m) => m.from === from && m.to !== from).map((m) => [`${m.to}|${m.actor}`, m]),
  );
  for (const { to, actor } of moves.values()) {
    const label = `${from} -> ${to} by ${actor}`;
    const reset = await move(client, id, to, actor, true);
    const allowed = RESETS.has(KEY(from, to, actor));
    if (allowed !== (reset.code === undefined))
      found.push(`${label} with a reset gave ${reset.code ?? "no error"}`);
    if (!allowed && reset.code !== "SH409") found.push(`${label} with a reset was not refused with SH409`);
    if (allowed && reset.effect !== "none") found.push(`${label} left effect ${reset.effect}`);
    const kept = await move(client, id, to, actor, false);
    const wanted = CONFIRMING.has(to) ? "confirmed" : "possible";
    if (kept.effect !== wanted) found.push(`${label} kept the effect as ${kept.effect}, wanted ${wanted}`);
  }
  return found;
}

// Statements that leave the state alone: the effect may not fall and the token may not go down, a harmless one passes.
async function sameStateProblems(client: Client, id: string, from: string): Promise<string[]> {
  const fall = await tried(client, id, "UPDATE app.operations SET effect = 'none' WHERE id = $1", [id]);
  const down = await tried(
    client,
    id,
    "UPDATE app.operations SET fencing_token = fencing_token - 1 WHERE id = $1",
    [id],
  );
  const beat = await tried(client, id, "UPDATE app.operations SET heartbeat_at = now() WHERE id = $1", [id]);
  return [
    ...(fall.code === "SH409" ? [] : [`${from}: an effect reset without a move gave ${fall.code}`]),
    ...(down.code === "SH409" ? [] : [`${from}: a lower token gave ${down.code}`]),
    ...(beat.code === undefined ? [] : [`${from}: a harmless update gave ${beat.code}`]),
  ];
}

describe("the effect and the token", () => {
  it.each(LEDGER_STATES)("from %s with effect possible and token 5", async (from) => {
    const id = await plant({
      variant: await newVariant(),
      state: from,
      extra: { effect: "possible", fencing_token: 5 },
    });
    const found = await admin(async (client) => {
      await client.query("BEGIN");
      const wrong = [
        ...(await effectProblems(client, id, from)),
        ...(await sameStateProblems(client, id, from)),
      ];
      await client.query("ROLLBACK");
      return wrong;
    });
    expect(found).toEqual([]);
  });

  it.each([
    ["an effect that is possible", { effect: "possible" }],
    ["an effect that is confirmed", { effect: "confirmed" }],
    ["a token of 1", { fencing_token: 1 }],
  ])("an insert with %s is refused", async (_what, extra) => {
    await expect(insert({ variant: await newVariant(), state: "pending", extra })).rejects.toMatchObject({
      code: "SH409",
    });
  });
});

// The reason table of the transition table: the reasons a state may carry. A blocked operation always carries one.
const REASONS: Record<string, string[]> = {
  paused: [
    "quota",
    "entitlement",
    "provider_cooldown",
    "capability_withdrawn",
    "api_sunset",
    "channel_disabled",
  ],
  blocked_reconnect: ["pending", "provider_accepted", "unknown_external_state"],
  provider_accepted: ["awaiting_user_action"],
  needs_human: ["past_due_after_reconnect", "awaiting_user_timeout", "media_unreachable"],
  cancelled: ["policy", "workspace_deleted"],
};
const EVERY_REASON = Object.values(REASONS).flat();
const LEASED = ["claimed", "dispatching", "reconciling", "processing", "provider_accepted"];
const SOON = new Date(Date.now() + 60_000);
const LEASE = { lease_owner: "worker-1", lease_expires_at: SOON };

// Columns that belong to some states only: [what is set, in which state, whether the database takes it].
const SCOPED: [string, string, Record<string, unknown>, boolean][] = [
  ...LEASED.map((state): [string, string, Record<string, unknown>, boolean] => [
    `a lease in ${state}`,
    state,
    LEASE,
    true,
  ]),
  ["a lease in pending", "pending", LEASE, false],
  ["a lease in published", "published", LEASE, false],
  ["blocked_since in pending", "pending", { blocked_since: SOON }, false],
  ["no blocked_since in blocked_reconnect", "blocked_reconnect", { blocked_since: null }, false],
  ["a processing deadline in processing", "processing", { processing_deadline: SOON }, true],
  ["a processing deadline in blocked_reconnect", "blocked_reconnect", { processing_deadline: SOON }, true],
  ["a processing deadline in pending", "pending", { processing_deadline: SOON }, false],
  ["a poll deadline in provider_accepted", "provider_accepted", { poll_deadline: SOON }, true],
  ["a poll deadline in blocked_reconnect", "blocked_reconnect", { poll_deadline: SOON }, true],
  ["a poll deadline in processing", "processing", { poll_deadline: SOON }, false],
  ["no reason in blocked_reconnect", "blocked_reconnect", { reason_code: null }, false],
];

const codeFor = (allowed: boolean) => (allowed ? undefined : "23514");

async function taken(
  state: string,
  extra: Record<string, unknown>,
  variant?: string,
): Promise<string | undefined> {
  try {
    await plant({ variant: variant ?? (await newVariant()), state, extra });
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Every reason in every state: the table pairs a state with its own reasons only.
const REASON_CASES = LEDGER_STATES.flatMap((state) =>
  EVERY_REASON.map((reason): [string, string, Record<string, unknown>, boolean] => [
    `${reason} in ${state}`,
    state,
    { reason_code: reason },
    (REASONS[state] ?? []).includes(reason),
  ]),
);

describe("columns and reasons that belong to a state", () => {
  it.each(LEDGER_STATES)(
    "%s: a scoped column or reason outside its state is refused; each allowed reason pairs",
    async (own) => {
      const refused = await newVariant();
      const wrong: string[] = [];
      for (const [what, state, extra, allowed] of [...SCOPED, ...REASON_CASES].filter(([, s]) => s === own)) {
        // A refused row is never stored, so one target serves them all; each stored row needs its own.
        const code = await taken(state, extra, allowed ? undefined : refused);
        // Outside its state a column or a reason is a check violation, not any other refusal.
        if (code !== codeFor(allowed)) wrong.push(`${what} gave ${code}`);
      }
      expect(wrong).toEqual([]);
    },
  );
});

const NON_TERMINAL = LEDGER_STATES.filter((state) => !TERMINAL.has(state));

describe("one operation per target", () => {
  it("two non-terminal operations for one target: the second insert is refused by R1; a terminal one frees the slot; an operation with no target is refused", async () => {
    for (const state of NON_TERMINAL) {
      const variant = await newVariant();
      await plant({ variant, state });
      await expect(
        insert({ variant, state: "pending", actor: "S" }),
        `${state} holds the slot`,
      ).rejects.toMatchObject({
        code: "23505",
      });
    }
    for (const state of TERMINAL_STATES) {
      const variant = await newVariant();
      await plant({ variant, state });
      await expect(
        insert({ variant, state: "pending", actor: "S" }),
        `${state} frees the slot`,
      ).resolves.toBeTruthy();
    }
    const variant = await newVariant();
    const none = { variant: null, reply: null };
    const two = { variant, reply: randomUUID() };
    await expect(insert({ variant, state: "pending", target: none })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert({ variant, state: "pending", target: two })).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a published part is settled once", () => {
  it("a second published publish operation for one variant part is refused, and a settled variant refuses a new publish insert except one that supersedes", async () => {
    const variant = await newVariant();
    await plant({ variant, state: "published" });
    await expect(plant({ variant, state: "published" })).rejects.toMatchObject({ code: "23505" });
    await expect(plant({ variant, state: "published", part: 1 })).resolves.toBeTruthy();
    await expect(plant({ variant, state: "published", kind: "edit" })).resolves.toBeTruthy();

    const settled = await newVariant(true);
    await expect(insert({ variant: settled, state: "pending", actor: "S" })).rejects.toMatchObject({
      code: "SH409",
    });
    await expect(
      insert({ variant: settled, state: "pending", actor: "S", kind: "edit" }),
    ).resolves.toBeTruthy();

    const replaced = await newVariant(true);
    const old = await plant({ variant: replaced, state: "needs_human" });
    await admin((client) =>
      client.query(
        "UPDATE app.operations SET state = 'superseded_after_unknown_outcome', last_actor = 'U' WHERE id = $1",
        [old],
      ),
    );
    await expect(
      insert({ variant: replaced, state: "pending", actor: "U", supersedes: old }),
    ).resolves.toBeTruthy();
  });
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
interface Asset {
  state?: string;
  age?: number;
  library?: boolean;
  deletedAgo?: number;
}
// An asset of the workspace with the age and flags a row of the garbage collection table names.
async function plantAsset(asset: Asset): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256,
       created_at, in_library, deleted_at)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'gc.png', 'upload', $3::uuid, $4::text,
       CASE WHEN $4::text IN ('uploaded', 'scanning', 'processing', 'ready') THEN sha256(convert_to($1::text, 'UTF8')) END,
       $5, $6, $7)`,
    [
      id,
      WA,
      U.editor,
      asset.state ?? "ready",
      ago(asset.age ?? 31),
      asset.library ?? false,
      asset.deletedAgo === undefined ? null : ago(asset.deletedAgo),
    ],
  );
  return id;
}
// An operation in `state` that sends the asset.
async function pin(asset: string, state: string, extra: Record<string, unknown> = {}) {
  const operation = await plant({ variant: await newVariant(), state, extra });
  await rows(
    `INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_sha256)
     VALUES ($1, $2, 0, $3, decode(repeat('ab', 32), 'hex'))`,
    [WA, operation, asset],
  );
}
async function reference(asset: string) {
  await rows(
    "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, 0, $3)",
    [WA, await newVariant(), asset],
  );
}

// Each row: the asset and what holds it, and the arm that offers it (none: not offered).
const COLLECTED: [string, () => Promise<string>, string | undefined][] = [
  ["a ready asset 31 days old that nothing uses", () => plantAsset({}), "unreferenced"],
  ["a ready asset 29 days old", () => plantAsset({ age: 29 }), undefined],
  ["an uploaded asset 31 days old (not ready)", () => plantAsset({ state: "uploaded" }), undefined],
  ["a ready asset in the library", () => plantAsset({ library: true }), undefined],
  [
    "a ready asset a post uses",
    async () => {
      const id = await plantAsset({});
      await reference(id);
      return id;
    },
    undefined,
  ],
  ...["unverified"].map((state): [string, () => Promise<string>, string | undefined] => [
    `a ready asset pinned by a ${state} operation`,
    async () => {
      const id = await plantAsset({});
      await pin(id, state);
      return id;
    },
    undefined,
  ]),
  ...["published", "failed", "cancelled", "missed"].map(
    (state): [string, () => Promise<string>, string | undefined] => [
      `a ready asset whose only operation is ${state}`,
      async () => {
        const id = await plantAsset({});
        await pin(id, state);
        return id;
      },
      "unreferenced",
    ],
  ),
  [
    "a ready asset of a superseded operation still watched",
    async () => {
      const id = await plantAsset({});
      await pin(id, "superseded_after_unknown_outcome", { unverified_until: new Date(Date.now() + DAY) });
      return id;
    },
    undefined,
  ],
  [
    "a ready asset of a superseded operation with no end to its watch recorded",
    async () => {
      const id = await plantAsset({});
      await pin(id, "superseded_after_unknown_outcome");
      return id;
    },
    undefined,
  ],
  [
    "a ready asset of a superseded operation whose watch has ended",
    async () => {
      const id = await plantAsset({});
      await pin(id, "superseded_after_unknown_outcome", { unverified_until: ago(1) });
      return id;
    },
    "unreferenced",
  ],
  [
    "a deleted asset 31 days after its deletion",
    () => plantAsset({ state: "deleted", deletedAgo: 31 }),
    "deleted",
  ],
  [
    "a deleted asset in the library",
    () => plantAsset({ state: "deleted", deletedAgo: 31, library: true }),
    undefined,
  ],
  [
    "a deleted asset an operation still pins",
    async () => {
      const id = await plantAsset({ state: "deleted", deletedAgo: 31 });
      await pin(id, "claimed");
      return id;
    },
    undefined,
  ],
];

describe("the garbage collection of media", () => {
  it.each(COLLECTED)("%s", async (_what, setup, arm) => {
    const asset = await setup();
    const client = await openTx(db.pool("worker"), {
      principalKind: "job",
      principalId: randomUUID(),
      workspaceIds: [WA],
    });
    try {
      const found = await client.query("SELECT asset_id, arm FROM app.media_gc_candidates(500)");
      expect(found.rows.find((row) => row.asset_id === asset)?.arm).toBe(arm);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("the purge of expired ledger rows", () => {
  it("removes the attempts of an operation settled over a year ago and the reservations 13 months old, and nothing else", async () => {
    const old = await plant({
      variant: await newVariant(),
      state: "failed",
      extra: { settled_at: ago(400) },
    });
    const recent = await plant({
      variant: await newVariant(),
      state: "failed",
      extra: { settled_at: ago(30) },
    });
    const open = await plant({ variant: await newVariant(), state: "pending" });
    for (const operation of [old, recent, open]) {
      await rows(
        `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, effect)
         VALUES ($1, $2, 1, 'commit', 0, 'none')`,
        [WA, operation],
      );
      for (const [age, key] of [
        [400, "posts_per_month"],
        [30, "ai_credits"],
      ] as const) {
        await rows(
          `INSERT INTO app.usage_reservations (workspace_id, organization_id, operation_id, key, amount, created_at)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [WA, OA, operation, `${key}`, ago(age)],
        );
      }
    }
    const purge = async (name: string) =>
      Number(
        (await db.pool("worker").query("SELECT removed FROM app.purge_expired($1)", [name])).rows[0].removed,
      );
    expect([await purge("app.operation_attempts"), await purge("app.usage_reservations")]).toEqual([1, 3]);
    const left = await rows(
      "SELECT operation_id FROM app.operation_attempts WHERE operation_id = ANY ($1) ORDER BY operation_id",
      [[old, recent, open]],
    );
    expect(left.map((row) => row.operation_id).sort()).toEqual([recent, open].sort());
  });
});

// What the definer role may touch of the ledger and of the tables the guards read, and the purposes it acts under
// (the two guards, the garbage collection of media, the purge of expired rows, and the ledger writers of 0020). Nothing
// else: attempts, resolutions and reservations are written by the definers of later migrations.
const GRANTS: Record<string, string[]> = {
  operations: ["INSERT", "SELECT"],
  operation_media: ["SELECT"],
  operation_attempts: ["DELETE", "SELECT"],
  operation_evidence: ["INSERT"],
  operation_resolutions: [],
  usage_reservations: ["DELETE", "SELECT"],
  ledger_transitions: ["SELECT"],
};
const POLICIES = [
  "media_gc_candidates_select on operation_media",
  "media_gc_candidates_select on operations",
  "media_gc_candidates_select on post_media",
  "ledger_guard_select on ledger_transitions",
  "ledger_guard_select on post_variants",
  "operation_cancel_insert on outbox",
  "operation_cancel_select on operations",
  "operation_cancel_select on post_variants",
  "operation_cancel_update on operations",
  "operation_insert_insert on operations",
  "operation_transition_select on ledger_transitions",
  "operation_transition_select on operations",
  "operation_transition_update on operations",
  "operation_transition_insert on operation_evidence",
  "operation_transition_insert on outbox",
  "operation_transition_select on channels",
  "operation_transition_update on channels",
  "record_evidence_insert on operation_evidence",
  "record_evidence_insert on outbox",
  "record_evidence_select on operations",
  "record_evidence_update on operations",
  "purge_expired_delete on operation_attempts",
  "purge_expired_delete on usage_reservations",
  "purge_expired_select on operation_attempts",
  "purge_expired_select on operations",
  "purge_expired_select on outbox",
  "purge_expired_select on usage_reservations",
];

describe("the definer role on the ledger", () => {
  it("holds exactly the grants and purpose policies the triggers, the media collection and the purge need", async () => {
    const held = await rows(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'shoutory_definer' AND table_schema = 'app' AND table_name = ANY ($1)`,
      [Object.keys(GRANTS)],
    );
    const byTable = Object.fromEntries(
      Object.keys(GRANTS).map((table) => [
        table,
        held
          .filter((row) => row.table_name === table)
          .map((row) => row.privilege_type as string)
          .sort(),
      ]),
    );
    expect(byTable).toEqual(GRANTS);
    const policies = await rows(
      `SELECT p.polname || ' on ' || c.relname AS policy FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'app'::regnamespace
         AND (p.polname LIKE 'ledger_guard\\_%' OR p.polname LIKE 'media_gc_candidates\\_%' OR p.polname LIKE 'purge_expired\\_%'
           OR p.polname LIKE 'operation\\_%' OR p.polname LIKE 'record\\_evidence\\_%')
         AND c.relname = ANY ($1)`,
      [[...Object.keys(GRANTS), "post_variants", "post_media", "outbox", "channels"]],
    );
    expect(policies.map((row) => row.policy as string).sort()).toEqual([...POLICIES].sort());
  });
});
