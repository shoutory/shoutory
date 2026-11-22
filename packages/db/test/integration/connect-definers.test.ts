import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, digestOf, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Security floor of migration 0015 (R545, R546): an OAuth sign-in state is written by one definer (`oauth_flow_put`),
// consumed once by another (`oauth_flow_take`), and refused, audited and spent when it does not match its user,
// provider, instance host or workspace; a Telegram connect word is consumed once by its own workspace and provider
// (`connect_challenge_take`); the step-up method CHECK knows `backup_code`. Grants and EXECUTE are also rows of
// runtime-grants and rls-catalog; the direct-grant rows here are the behaviour. Rows are planted as the superuser, time
// moves by planting dates, nothing sleeps. The argument lists and outcome names are the contract the migration must
// meet: a take answers one row whose `outcome` is `ok` or the refusal kind, with the flow columns on an `ok`.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const IP = Buffer.alloc(32, 7);
const sealed = () => [
  1,
  "k1",
  randomBytes(12),
  randomBytes(48),
  randomBytes(16),
  randomBytes(12),
  randomBytes(16),
  randomBytes(48),
];
const SEALED_COLUMNS = "format_version, key_id, iv, ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek";
const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const SERVICE: TenantCtx = {
  principalKind: "service",
  serviceKind: "api_key",
  principalId: randomUUID(),
  workspaceIds: [WA],
  writeWorkspaceId: WA,
};
const PORTAL: TenantCtx = { principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [WA] };

interface PlantedFlow {
  state: string;
  user?: string;
  ws?: string;
  host?: string | null;
  expires?: string;
  consumed?: boolean;
}
// A flow as the superuser, in any state; the sealed values are returned to compare a take with them.
async function plantFlow(o: PlantedFlow) {
  const seal = sealed();
  await rows(
    `INSERT INTO app.oauth_flows (workspace_id, user_id, provider_id, instance_host, state_hash, ${SEALED_COLUMNS},
       expires_at, consumed_at)
     VALUES ($1, $2, 'fixture_oauth', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() + $13::interval,
       CASE WHEN $14 THEN now() END)`,
    [
      o.ws ?? WA,
      o.user ?? U.admin,
      o.host ?? null,
      digestOf(o.state),
      ...seal,
      o.expires ?? "10 minutes",
      o.consumed ?? false,
    ],
  );
  return seal;
}
const flowOf = async (state: string, ws = WA) =>
  (
    await rows("SELECT * FROM app.oauth_flows WHERE state_hash = $1 AND workspace_id = $2", [
      digestOf(state),
      ws,
    ])
  )[0];

const TAKE_FLOW = "SELECT * FROM app.oauth_flow_take($1, $2, $3, $4, $5)";
const takeCall = (state: string, provider = "fixture_oauth", host: string | null = null, request = "req-t") =>
  [TAKE_FLOW, [digestOf(state), provider, host, request, IP]] as [string, unknown[]];
const auditOf = (request: string) =>
  rows("SELECT action, workspace_id, metadata FROM app.audit_logs WHERE request_id = $1", [request]);

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

// One outcome kind per refusal; every refusal but an unknown state spends the state (R546 Q5); each writes one audit
// row, in the flow's workspace chain when the flow was found and in the instance chain (no workspace) when not.
interface Refusal {
  name: string;
  kind: string;
  plant?: Partial<PlantedFlow>;
  caller?: string;
  provider?: string;
  host?: string | null;
  forged?: true;
}
const REFUSALS: Refusal[] = [
  { name: "a forged state", kind: "unknown_state", forged: true },
  { name: "an already consumed state", kind: "consumed", plant: { consumed: true } },
  { name: "an expired state", kind: "expired", plant: { expires: "-1 second" } },
  { name: "another user", kind: "wrong_user", caller: U.admin2 },
  { name: "another provider", kind: "wrong_provider", provider: "other_provider" },
  {
    name: "another instance host",
    kind: "wrong_instance_host",
    plant: { host: "a.example" },
    host: "b.example",
  },
  {
    name: "a caller no longer Admin of the workspace",
    kind: "not_admin",
    plant: { user: U.editor },
    caller: U.editor,
  },
];

describe("oauth_flow_take", () => {
  it("two concurrent takes of one state: one ok, one refused as consumed, the flow consumed once", async () => {
    const state = `race-${randomUUID()}`;
    const seal = await plantFlow({ state });
    const outcomes: Record<number, unknown> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("app"), asUser(U.admin)),
      await openTx(db.pool("app"), asUser(U.admin)),
      async (client, n) => {
        const [sql, params] = takeCall(state, "fixture_oauth", null, `req-race-${n}`);
        outcomes[n] = (await client.query(sql, params)).rows[0];
      },
    );
    expect(result.secondError).toBeUndefined();
    expect(outcomes[1]).toMatchObject({ outcome: "ok", ciphertext: seal[3] });
    expect(outcomes[2]).toMatchObject({ outcome: "consumed" });
    expect((await flowOf(state))?.consumed_at).not.toBeNull();
    expect(await auditOf("req-race-2")).toHaveLength(1);
  });

  it("an unexpired state of its user, provider and host is returned once, writes no audit row, and is spent", async () => {
    const state = `ok-${randomUUID()}`;
    const request = `req-ok-${randomUUID()}`;
    const seal = await plantFlow({ state, host: "social.example" });
    const take = (id = "req-again") =>
      commitAs(db.pool("app"), U.admin, ...takeCall(state, "fixture_oauth", "social.example", id));
    expect((await take(request))[0]).toMatchObject({
      outcome: "ok",
      workspace_id: WA,
      instance_host: "social.example",
      ciphertext: seal[3],
      wrapped_dek: seal[7],
    });
    expect(await auditOf(request)).toEqual([]);
    expect((await take())[0]).toMatchObject({ outcome: "consumed" });
  });
});

describe("oauth_flow_take refusals", () => {
  it.each(REFUSALS)(
    "$name gets the outcome $kind, one audit row naming it, and the state stays spent",
    async (c) => {
      const state = `refuse-${randomUUID()}`;
      const request = `req-${randomUUID()}`;
      if (!c.forged) await plantFlow({ state, ...c.plant });
      const caller = c.caller ?? c.plant?.user ?? U.admin;
      const host = c.host ?? c.plant?.host ?? null;
      const [row] = await commitAs(db.pool("app"), caller, ...takeCall(state, c.provider, host, request));
      expect(row).toMatchObject({ outcome: c.kind });
      expect(row?.ciphertext ?? null).toBeNull();
      expect(await auditOf(request)).toMatchObject([
        {
          action: "channel.connect_refused",
          workspace_id: c.forged ? null : WA,
          metadata: { outcome: c.kind },
        },
      ]);
      if (c.forged) expect(await flowOf(state)).toBeUndefined();
      else expect((await flowOf(state))?.consumed_at).not.toBeNull();
    },
  );
});

describe("oauth_flow_take callers and ambiguity", () => {
  it("an ambiguous match (the same state hash in two workspaces) returns neither flow and spends both", async () => {
    const state = `ambiguous-${randomUUID()}`;
    await plantFlow({ state });
    await plantFlow({ state, ws: WB, user: U.bOwner });
    const [row] = await commitAs(db.pool("app"), U.admin, ...takeCall(state));
    expect(row).toMatchObject({ outcome: "ambiguous" });
    expect(row?.ciphertext ?? null).toBeNull();
    expect((await flowOf(state))?.consumed_at).not.toBeNull();
    expect((await flowOf(state, WB))?.consumed_at).not.toBeNull();
  });

  it.each([
    ["a job principal", job([WA]), "app"],
    ["a service principal", SERVICE, "app"],
    ["a portal principal", PORTAL, "app"],
    ["a job principal on the worker pool", job([WA]), "worker"],
  ] as [string, TenantCtx, "app" | "worker"][])(
    "%s may not take a state (42501)",
    async (_who, ctx, pool) => {
      const state = `principal-${randomUUID()}`;
      await plantFlow({ state });
      const [sql, params] = takeCall(state);
      expect((await attempt(db.pool(pool), ctx, sql, params)).error).toMatchObject({ code: "42501" });
      expect((await flowOf(state))?.consumed_at).toBeNull();
    },
  );
});

const putCall = (
  ws: string,
  state: string,
  seal = sealed(),
  host: string | null = null,
  channel: string | null = null,
  flow: string = randomUUID(),
) =>
  [
    "SELECT app.oauth_flow_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) AS id",
    [flow, ws, "fixture_oauth", digestOf(state), channel, host, ...seal, "https://par.example/request"],
  ] as [string, unknown[]];

async function plantChannel(workspace: string, provider = "fixture_oauth"): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name,
       connection_state)
     VALUES ($1::uuid, $2, $3, 'profile', $1::text, 'flow channel', 'connected')`,
    [id, workspace, provider],
  );
  return id;
}

describe("oauth_flow_put", () => {
  it("seals and inserts one flow for the caller and their workspace, expiring in 10 minutes", async () => {
    const state = `put-${randomUUID()}`;
    const seal = sealed();
    const [made] = await commitAs(db.pool("app"), U.admin, ...putCall(WA, state, seal, "social.example"));
    expect(await flowOf(state)).toMatchObject({
      id: made?.id,
      workspace_id: WA,
      user_id: U.admin,
      provider_id: "fixture_oauth",
      instance_host: "social.example",
      consumed_at: null,
      ciphertext: seal[3],
    });
    const left = await rows(
      "SELECT extract(epoch FROM expires_at - clock_timestamp()) / 60 AS minutes FROM app.oauth_flows WHERE id = $1",
      [made?.id],
    );
    expect(Number(left[0]?.minutes)).toBeGreaterThan(9);
    expect(Number(left[0]?.minutes)).toBeLessThanOrEqual(10);
  });

  it.each([
    ["an Editor of the workspace", asUser(U.editor), WA],
    ["an Admin of another workspace", asUser(U.bOwner), WA],
    ["an Admin asking for another workspace", asUser(U.admin), WB],
    ["a job principal", job([WA]), WA],
    ["a service principal", SERVICE, WA],
  ] as [string, TenantCtx, string][])(
    "%s cannot put a flow (42501) and nothing is written",
    async (_who, ctx, ws) => {
      const state = `put-refused-${randomUUID()}`;
      const [sql, params] = putCall(ws, state);
      expect((await attempt(db.pool("app"), ctx, sql, params)).error).toMatchObject({ code: "42501" });
      expect(await flowOf(state)).toBeUndefined();
    },
  );

  it("a channel of the same workspace is stored with the flow", async () => {
    const state = `put-own-channel-${randomUUID()}`;
    const channel = await plantChannel(WA);
    await commitAs(db.pool("app"), U.admin, ...putCall(WA, state, sealed(), null, channel));
    expect(await flowOf(state)).toMatchObject({ channel_id: channel });
  });

  // A channel of another provider is refused exactly as one of another workspace (the flow is for one provider).
  it.each([
    ["another workspace", () => plantChannel(WB)],
    ["another provider", () => plantChannel(WA, "other_provider")],
  ])("a channel of %s is refused with 42501 and nothing is written", async (_name, plant) => {
    const state = `put-foreign-channel-${randomUUID()}`;
    const [sql, params] = putCall(WA, state, sealed(), null, await plant());
    expect((await attempt(db.pool("app"), asUser(U.admin), sql, params)).error).toMatchObject({
      code: "42501",
    });
    expect(await flowOf(state)).toBeUndefined();
  });
});

// The service reads the flow id first and seals the verifier with it as the owner, so the definer stores that id.
describe("oauth_flow_put with a chosen id", () => {
  it("stores the id the caller chose, which is also the id it answers", async () => {
    const chosen = randomUUID();
    const state = `put-id-${randomUUID()}`;
    const call = putCall(WA, state, sealed(), null, null, chosen);
    const [made] = await commitAs(db.pool("app"), U.admin, ...call);
    expect(made?.id).toBe(chosen);
    expect((await flowOf(state))?.id).toBe(chosen);
  });
});

const DIRECT: [string, string, string][] = [
  [
    "oauth_flows",
    "insert",
    `INSERT INTO app.oauth_flows (workspace_id, user_id, provider_id, state_hash, ${SEALED_COLUMNS}, expires_at)
     VALUES ('${WA}', '${U.admin}', 'fixture_oauth', '\\x${"ab".repeat(32)}', 1, 'k1', '\\x00', '\\x00', '\\x00',
       '\\x00', '\\x00', '\\x00', now())`,
  ],
  [
    "connect_challenges",
    "insert",
    `INSERT INTO app.connect_challenges (workspace_id, provider_id, code_hash, expires_at)
     VALUES ('${WA}', 'telegram', '\\x${"cd".repeat(32)}', now())`,
  ],
];

describe("what the runtime roles may do to the two tables directly", () => {
  const cases = DIRECT.flatMap(([table, what, sql]) => [
    { table, what, sql, pool: "app" as const, ctx: asUser(U.admin) },
    { table, what, sql, pool: "worker" as const, ctx: job([WA]) },
  ]);
  it.each(cases)("the $pool role cannot $what on $table (42501)", async ({ sql, pool, ctx }) => {
    expect((await attempt(db.pool(pool), ctx, sql)).error).toMatchObject({ code: "42501" });
  });
});

async function plantWord(word: string, o: { ws?: string; provider?: string; expires?: string } = {}) {
  await rows(
    "INSERT INTO app.connect_challenges (workspace_id, provider_id, code_hash, expires_at) VALUES ($1, $2, $3, now() + $4::interval)",
    [o.ws ?? WA, o.provider ?? "telegram", digestOf(word), o.expires ?? "10 minutes"],
  );
}
const TAKE_WORD = "SELECT app.connect_challenge_take($1, $2, $3) AS id";
const takeWord = (
  ws: string,
  provider: string,
  word: string,
  ctx: TenantCtx = job([WA]),
  pool: "app" | "worker" = "worker",
) => attempt(db.pool(pool), ctx, TAKE_WORD, [ws, provider, digestOf(word)]);
const consumedAt = async (word: string, ws = WA) =>
  (
    await rows("SELECT consumed_at FROM app.connect_challenges WHERE workspace_id = $1 AND code_hash = $2", [
      ws,
      digestOf(word),
    ])
  )[0]?.consumed_at;

describe("connect_challenge_take", () => {
  it("matches only its own workspace and provider, once", async () => {
    const word = `once-${randomUUID()}`;
    await plantWord(word);
    await plantWord(word, { ws: WB });
    expect((await takeWord(WA, "discord", word)).rows).toEqual([{ id: null }]);
    expect((await takeWord(WA, "telegram", `${word}-other`)).rows).toEqual([{ id: null }]);
    expect(await consumedAt(word)).toBeNull();
    const client = await openTx(db.pool("worker"), job([WA]));
    try {
      const args = [WA, "telegram", digestOf(word)];
      expect((await client.query(TAKE_WORD, args)).rows[0]?.id).toEqual(expect.any(String));
      expect((await client.query(TAKE_WORD, args)).rows).toEqual([{ id: null }]);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await consumedAt(word)).not.toBeNull();
    expect(await consumedAt(word, WB)).toBeNull();
  });

  it("never matches a word past its 10 minutes", async () => {
    const word = `old-${randomUUID()}`;
    await plantWord(word, { expires: "-1 second" });
    expect((await takeWord(WA, "telegram", word)).rows).toEqual([{ id: null }]);
    expect(await consumedAt(word)).toBeNull();
  });

  it("two concurrent takes of one word: one gets the id, the other none", async () => {
    const word = `race-${randomUUID()}`;
    await plantWord(word);
    const got: Record<number, unknown> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("worker"), job([WA])),
      await openTx(db.pool("worker"), job([WA])),
      async (client, n) => {
        got[n] = (await client.query(TAKE_WORD, [WA, "telegram", digestOf(word)])).rows[0]?.id;
      },
    );
    expect(result.secondError).toBeUndefined();
    expect(got[1]).toEqual(expect.any(String));
    expect(got[2]).toBeNull();
  });
});

describe("connect_challenge_take callers", () => {
  it.each([
    ["a job principal of another workspace", job([WB]), "worker"],
    ["a user Editor of the workspace", asUser(U.editor), "app"],
    ["a service principal", SERVICE, "app"],
  ] as [string, TenantCtx, "app" | "worker"][])(
    "%s cannot take a word of Workspace A (42501)",
    async (_who, ctx, pool) => {
      const word = `caller-${randomUUID()}`;
      await plantWord(word);
      expect((await takeWord(WA, "telegram", word, ctx, pool)).error).toMatchObject({ code: "42501" });
      expect(await consumedAt(word)).toBeNull();
    },
  );
});

describe("session_step_ups method", () => {
  const record = (method: string) =>
    admin((client) =>
      client
        .query("INSERT INTO app.session_step_ups (session_id, user_id, method) VALUES ($1, $2, $3)", [
          randomUUID(),
          U.admin,
          method,
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    );
  it("accepts backup_code and refuses an unknown method", async () => {
    expect(await record("backup_code")).toBeUndefined();
    expect(await record("sms")).toMatchObject({ code: "23514" });
  });
});
