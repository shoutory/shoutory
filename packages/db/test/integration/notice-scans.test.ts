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

async function run(sql: string, params: unknown[] = [], ctx: TenantCtx = LEDGER) {
  const client = await openTx(db.pool("worker"), ctx);
  try {
    const answer = await client.query(sql, params);
    await client.query("COMMIT");
    return answer.rows as Record<string, unknown>[];
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Candidate {
  kind: string;
  workspace_id: string;
  subject_id: string;
  level: string;
  step: number;
  vars: Record<string, unknown>;
}
const candidates = async (subject: string) =>
  (await run("SELECT * FROM app.notice_candidates(500)")).filter(
    (row) => row.subject_id === subject,
  ) as unknown as Candidate[];
const levelsOf = async (subject: string) => (await candidates(subject)).map((row) => row.level);

interface Channel {
  state?: string;
  tokenIn?: string | null;
  refresh?: boolean;
  deadlineIn?: string | null;
}
async function plantChannel(o: Channel = {}): Promise<string> {
  const provider = `scan-${randomUUID().slice(0, 8)}`;
  const [channel] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, nickname,
       connection_state, reconnect_deadline)
     VALUES ($1, $2, 'profile', $2, $2, 'Shop page', $3, now() + $4::interval) RETURNING id`,
    [WA, provider, o.state ?? "connected", o.deadlineIn ?? null],
  );
  if (o.tokenIn !== undefined || o.deadlineIn !== undefined) {
    await rows(
      `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
         ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek, access_expires_at, refresh_token_digest)
       VALUES ($1, $2, 1, 'channel_token', 1, 'k1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06',
         now() + $3::interval, $4)`,
      [WA, channel?.id, o.tokenIn ?? null, o.refresh ? "digest-1" : null],
    );
  }
  return channel?.id as string;
}
// A token or deadline notice belongs to the credential, at the level of its generation.
const credentialOf = async (channel: string) =>
  (await rows("SELECT id FROM app.channel_credentials WHERE channel_id = $1", [channel]))[0]?.id as string;

describe("token expiry candidates use the expiry predicate and the smallest crossed level", () => {
  // [time left on a token with no refresh, the one level it gets at first sight]
  it.each([
    ["13 days", "14d"],
    ["10 days", "14d"],
    ["6 days", "7d"],
    ["3 days 1 hour", "7d"],
    ["20 hours", "1d"],
    ["1 minute", "1d"],
  ])("a token with %s left is first seen at level %s only", async (left, level) => {
    const channel = await plantChannel({ tokenIn: left });
    expect(await levelsOf(await credentialOf(channel))).toEqual([`g1:${level}`]);
  });

  it.each([
    ["15 days left", { tokenIn: "15 days" }],
    ["already expired", { tokenIn: "-1 minute" }],
    ["a refresh token", { tokenIn: "2 days", refresh: true }],
    ["a channel that is not connected", { tokenIn: "2 days", state: "needs_reconnect" }],
    ["no credential", {}],
  ] as [string, Channel][])("gives no candidate for %s", async (_name, o) => {
    const channel = await plantChannel(o);
    expect(await levelsOf((await credentialOf(channel)) ?? channel)).toEqual([]);
  });

  it("names the channel and the days, and leaves out a level that was already sent", async () => {
    const credential = await credentialOf(await plantChannel({ tokenIn: "5 days" }));
    const [first] = await candidates(credential);
    expect(first).toMatchObject({
      kind: "token_expiry",
      workspace_id: WA,
      level: "g1:7d",
      vars: { name: "Shop page", days: 7 },
    });
    await run("SELECT app.notice_create($1, $2, 'token_expiry', $3, 'g1:7d', '{}'::jsonb)", [
      WA,
      U.admin,
      credential,
    ]);
    expect(await levelsOf(credential)).toEqual([]);
    await rows(
      "UPDATE app.channel_credentials SET access_expires_at = now() + interval '5 hours' WHERE id = $1",
      [credential],
    );
    expect(await levelsOf(credential)).toEqual(["g1:1d"]);
  });
});

describe("reconnect deadline candidates", () => {
  it.each([
    ["10 days", "14d"],
    ["5 days", "7d"],
    ["12 hours", "1d"],
  ])("a channel that must reconnect within %s is first seen at level %s only", async (left, level) => {
    const channel = await plantChannel({ state: "needs_reconnect", deadlineIn: left });
    expect(await levelsOf(await credentialOf(channel))).toEqual([`g1:${level}`]);
  });

  it.each([
    ["more than 14 days left", { state: "needs_reconnect", deadlineIn: "20 days" }],
    ["a deadline that passed", { state: "disconnected", deadlineIn: "-1 hour" }],
    ["a connected channel with an old deadline", { state: "connected", deadlineIn: "3 days" }],
  ] as [string, Channel][])("gives no candidate for %s", async (_name, o) => {
    expect(await levelsOf(await credentialOf(await plantChannel(o)))).toEqual([]);
  });

  it("a disconnected channel counts like one that needs a reconnect", async () => {
    const channel = await plantChannel({ state: "disconnected", deadlineIn: "2 days" });
    expect((await candidates(await credentialOf(channel))).map((row) => [row.kind, row.level])).toEqual([
      ["reconnect_deadline", "g1:7d"],
    ]);
  });
});

interface Planted {
  channel: string;
  post: string;
  variant: string;
  version: string;
  operation: string;
}
async function plantTarget(
  o: { state?: string; schedule?: string; dueAgo?: string; media?: string; asset?: string } = {},
): Promise<Planted> {
  const channel = await plantChannel();
  return admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
        [WA, U.editor],
      )
    ).rows[0].id as string;
    const snapshot = { version: 1, resolved: { media: o.media ? { [o.media]: "ab" } : {} } };
    const version = (
      await client.query(
        `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
         VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
        [WA, post, JSON.stringify(snapshot), U.editor],
      )
    ).rows[0].id as string;
    const variant = (
      await client.query(
        `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, due_at)
         VALUES ($1, $2, $3, $4, $5, now() - $6::interval) RETURNING id`,
        [WA, post, channel, o.schedule ?? "in_progress", version, o.dueAgo ?? "5 minutes"],
      )
    ).rows[0].id as string;
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token, next_escalation_at, settled_at)
       VALUES ($1, $2, $3, 'scan-provider', 'publish.scan-provider', 'publish', $4, 'none', 'S',
         now() - interval '5 minutes', now() - interval '1 minute', now() + interval '2 hours', $5, $6,
         decode(repeat('ab', 32), 'hex'), $7, 60, 1, now() - interval '1 minute', $8)
       RETURNING id`,
      [
        WA,
        variant,
        channel,
        o.state ?? "needs_human",
        `scan-${randomUUID()}`,
        version,
        U.editor,
        o.state === "cancelled" ? new Date() : null,
      ],
    );
    await client.query("COMMIT");
    return { channel, post, variant, version, operation: made.rows[0].id as string };
  });
}

const advance = (planted: Planted, step: number) =>
  run("SELECT app.notice_escalation_advance($1, $2, $3) AS moved", [WA, planted.operation, step]);
const nextIn = async (planted: Planted) =>
  (
    await rows(
      "SELECT extract(epoch FROM next_escalation_at - clock_timestamp()) / 86400 AS days FROM app.operations WHERE id = $1",
      [planted.operation],
    )
  )[0]?.days as number;

describe("escalation candidates follow the schedule of entry, 1 day, 3 days, 7 days and then weekly", () => {
  it.each(["needs_human", "unverified"])(
    "an operation in %s is a candidate at step 0 at its entry",
    async (state) => {
      const planted = await plantTarget({ state });
      const [only] = await candidates(planted.operation);
      expect(only).toMatchObject({ kind: state, level: "escalation_0", step: 0, workspace_id: WA });
    },
  );

  // [step just sent, days until the next one]
  it.each([
    [0, 1],
    [1, 2],
    [2, 4],
    [3, 7],
    [9, 7],
  ])(
    "after step %i the next one is %i days away, and it is not a candidate before then",
    async (step, days) => {
      const planted = await plantTarget();
      expect((await advance(planted, step))[0]?.moved).toBe(true);
      expect(await nextIn(planted)).toBeCloseTo(days, 2);
      expect(await candidates(planted.operation)).toEqual([]);
    },
  );
});

describe("the step of an escalation and when it stops", () => {
  it("the step after a sent one comes from the notices already written", async () => {
    const planted = await plantTarget();
    await run("SELECT app.notice_create($1, $2, 'needs_human', $3, 'escalation_0', '{}'::jsonb)", [
      WA,
      U.editor,
      planted.operation,
    ]);
    expect((await candidates(planted.operation)).map((row) => [row.level, row.step])).toEqual([
      ["escalation_1", 1],
    ]);
  });

  it.each(["cancelled", "published", "pending"])(
    "an operation that moved on to %s stops escalating",
    async (state) => {
      const planted = await plantTarget({ state });
      expect(await candidates(planted.operation)).toEqual([]);
    },
  );

  it("an operation of a state that does not escalate cannot be advanced", async () => {
    const planted = await plantTarget({ state: "pending" });
    expect((await advance(planted, 0))[0]?.moved).toBe(false);
  });
});

describe("held media candidates use the one held-media predicate", () => {
  const asset = async (state: string) => {
    const id = randomUUID();
    await rows(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'held.mp4', 'video/mp4',
         'upload', $3::uuid, $4, decode(md5($1::text) || md5($2::text), 'hex'))`,
      [id, WA, U.editor, state],
    );
    return id;
  };

  it.each([
    ["processing", "1 minute", true],
    ["rejected", "1 minute", true],
    ["ready", "1 minute", false],
    ["processing", "-10 minutes", false],
    ["processing", "5 hours", false],
  ])("a scheduled variant with a %s medium, due %s ago, is a candidate: %s", async (state, ago, held) => {
    const planted = await plantTarget({ schedule: "scheduled", dueAgo: ago, media: await asset(state) });
    const found = await candidates(planted.variant);
    expect(found.map((row) => [row.kind, row.level])).toEqual(held ? [["held_media", "held"]] : []);
  });

  it("a medium that does not exist holds the variant, and a variant already in progress is not listed", async () => {
    const missing = await plantTarget({ schedule: "scheduled", dueAgo: "1 minute", media: randomUUID() });
    expect(await levelsOf(missing.variant)).toEqual(["held"]);
    const moving = await plantTarget({ schedule: "in_progress", dueAgo: "1 minute", media: randomUUID() });
    expect(await levelsOf(moving.variant)).toEqual([]);
  });
});

describe("the post of a held target that reconnect did not save", () => {
  it("is a day-30 candidate once its operation was cancelled by the deadline, and not for another cancel", async () => {
    const passed = await plantTarget({ state: "cancelled" });
    await rows(
      "UPDATE app.channels SET connection_state = 'disconnected', reconnect_deadline = now() - interval '1 hour' WHERE id = $1",
      [passed.channel],
    );
    expect((await candidates(passed.post)).map((row) => [row.kind, row.level])).toEqual([
      ["drafts_day_30", "30d"],
    ]);
    const other = await plantTarget({ state: "cancelled" });
    expect(await candidates(other.post)).toEqual([]);
  });
});

describe("who may call the scans", () => {
  it.each([
    ["the app role", "app"],
    ["a worker that is not the ledger job", "worker"],
  ] as const)("%s is refused", async (_name, pool) => {
    const ctx: TenantCtx =
      pool === "app"
        ? { principalKind: "user", principalId: U.admin }
        : { principalKind: "job", principalId: randomUUID(), jobPurpose: "credential_refresh" };
    const client = await openTx(db.pool(pool), ctx);
    try {
      await expect(client.query("SELECT * FROM app.notice_candidates(10)")).rejects.toMatchObject({
        code: expect.stringMatching(/^42501$/),
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("refuses a limit outside 1 to 500", async () => {
    await expect(run("SELECT * FROM app.notice_candidates(0)")).rejects.toMatchObject({ code: "22023" });
  });
});
