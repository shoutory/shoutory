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
const MAIL = (user: string) => `${user.toLowerCase()}-m06a@example.test`;
const EMAILS = Object.fromEntries(Object.entries(U).map(([name, id]) => [id, MAIL(name)]));

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

const LEDGER: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "ledger" };
const OTHER_WORKSPACE_JOB: TenantCtx = {
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: [WB],
};
const reader = (user: string, workspace: string): TenantCtx => ({
  ...asUser(user),
  workspaceIds: [workspace],
});

interface Answer {
  rows: Record<string, unknown>[];
  rowCount: number;
  error: { code?: string; message?: string } | undefined;
}
async function exec(
  ctx: TenantCtx,
  pool: "worker" | "app",
  sql: string,
  params: unknown[] = [],
): Promise<Answer> {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const answer = await client.query(sql, params);
    await client.query("COMMIT");
    return { rows: answer.rows, rowCount: answer.rowCount ?? 0, error: undefined };
  } catch (error) {
    return { rows: [], rowCount: 0, error: error as Answer["error"] };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Notice {
  workspace?: string;
  user?: string;
  kind?: string;
  subject?: string;
  level?: string;
}
const SUBJECT = randomUUID();
const create = (n: Notice = {}, ctx: TenantCtx = LEDGER) =>
  exec(ctx, "worker", "SELECT app.notice_create($1, $2, $3, $4, $5, '{}'::jsonb) AS made", [
    n.workspace ?? WA,
    n.user ?? U.admin,
    n.kind ?? "token_expiry",
    n.subject ?? SUBJECT,
    n.level ?? "7d",
  ]);
const notices = (user: string, kind = "token_expiry") =>
  rows("SELECT * FROM app.notifications WHERE user_id = $1 AND kind = $2", [user, kind]);
const mails = (user: string, template = "token_expiry") =>
  rows("SELECT * FROM app.email_outbox WHERE recipient = $1 AND template = $2", [EMAILS[user], template]);
const fresh = () => ({ subject: randomUUID() });

describe("a notice is created once per workspace, user, kind, subject and level", () => {
  it("the second call is not new, and only the first writes a row and a mail", async () => {
    const n = fresh();
    const before = (await mails(U.admin)).length;
    const first = await create(n);
    const afterFirst = (await mails(U.admin)).length;
    const second = await create(n);
    expect([first.error, second.error]).toEqual([undefined, undefined]);
    expect([first.rows[0]?.made, second.rows[0]?.made]).toEqual([true, false]);
    expect((await rows("SELECT 1 FROM app.notifications WHERE subject_id = $1", [n.subject])).length).toBe(1);
    expect([afterFirst - before, (await mails(U.admin)).length - before]).toEqual([1, 1]);
  });

  it("eight callers at once give one notification and one mail", async () => {
    const n = { ...fresh(), user: U.owner, kind: "needs_human", level: "entry" };
    const before = (await mails(U.owner, "needs_human")).length;
    const answers = await Promise.all(Array.from({ length: 8 }, () => create(n)));
    expect(answers.map((a) => a.error)).toEqual(Array(8).fill(undefined));
    expect(answers.filter((a) => a.rows[0]?.made === true)).toHaveLength(1);
    expect((await rows("SELECT 1 FROM app.notifications WHERE subject_id = $1", [n.subject])).length).toBe(1);
    expect((await mails(U.owner, "needs_human")).length - before).toBe(1);
  });

  it.each<[string, Notice]>([
    ["another level", { level: "1d" }],
    ["another kind", { kind: "held_media" }],
    ["another user", { user: U.owner }],
    ["another subject", { subject: randomUUID() }],
  ])("%s is a new notice with its own mail", async (_name, change) => {
    const n = fresh();
    await create(n);
    const [user, template] = [change.user ?? U.admin, change.kind ?? "token_expiry"];
    const before = (await mails(user, template)).length;
    const made = await create({ ...n, ...change });
    expect(made.rows[0]?.made).toBe(true);
    expect((await mails(user, template)).length - before).toBe(1);
  });
});

describe("a notice that must not be created", () => {
  it("a call that rolls back leaves no notification and no mail, and the next call is new", async () => {
    const n = { ...fresh(), user: U.approver, kind: "held_media", level: "entry" };
    const client = await openTx(db.pool("worker"), LEDGER);
    try {
      await client.query("SELECT app.notice_create($1, $2, $3, $4, $5, '{}'::jsonb)", [
        WA,
        n.user,
        n.kind,
        n.subject,
        n.level,
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await notices(U.approver, "held_media")).toEqual([]);
    expect(await mails(U.approver, "held_media")).toEqual([]);
    expect((await create(n)).rows[0]?.made).toBe(true);
    expect((await mails(U.approver, "held_media")).length).toBe(1);
  });

  it("refuses a user who is not a member of the workspace, an unknown kind, and a workspace the job does not serve", async () => {
    const refusals = await Promise.all([
      create({ ...fresh(), user: U.bOwner }),
      create({ ...fresh(), kind: "not_a_kind" }),
      create({ ...fresh(), workspace: WA }, OTHER_WORKSPACE_JOB),
      create({ ...fresh() }, asUser(U.admin)),
    ]);
    expect(refusals.map((answer) => answer.error !== undefined)).toEqual([true, true, true, true]);
    expect(await notices(U.bOwner)).toEqual([]);
  });
});

describe("a reader sees only their own notices in their own workspace", () => {
  const seen = (ctx: TenantCtx) =>
    exec(
      ctx,
      "app",
      "SELECT user_id, workspace_id FROM app.notifications WHERE level = 'reader' ORDER BY user_id",
    );

  beforeAll(async () => {
    for (const [user, workspace] of [
      [U.admin, WA],
      [U.owner, WA],
      [U.bOwner, WB],
    ] as const) {
      const made = await create({ user, workspace, kind: "token_expiry", level: "reader" });
      if (made.error) throw new Error(`could not plant a notice: ${made.error.message}`);
    }
  });

  it.each([
    ["admin", U.admin, WA, [U.admin]],
    ["owner", U.owner, WA, [U.owner]],
    ["editor", U.editor, WA, []],
    ["the other workspace's owner", U.bOwner, WB, [U.bOwner]],
    ["the other workspace's owner reading WA", U.bOwner, WA, []],
    ["an organization admin who is a stored viewer", U.viewerOrgAdmin, WA, []],
  ] as const)("%s reads exactly their own rows", async (_name, user, workspace, expected) => {
    const answered = await seen(reader(user, workspace));
    expect(answered.error).toBeUndefined();
    expect(answered.rows.map((row) => row.user_id)).toEqual([...expected]);
  });

  it("the app role cannot write a notification, change or delete one", async () => {
    const ctx = { ...reader(U.admin, WA), writeWorkspaceId: WA };
    const attempts = await Promise.all([
      exec(
        ctx,
        "app",
        "INSERT INTO app.notifications (workspace_id, user_id, kind, subject_id, level) VALUES ($1, $2, 'token_expiry', $3, 'x')",
        [WA, U.admin, randomUUID()],
      ),
      exec(ctx, "app", "UPDATE app.notifications SET level = 'tampered' WHERE user_id = $1", [U.admin]),
      exec(ctx, "app", "DELETE FROM app.notifications WHERE user_id = $1", [U.admin]),
    ]);
    expect(attempts.map((a) => a.error?.code)).toEqual(["42501", "42501", "42501"]);
    expect((await rows("SELECT 1 FROM app.notifications WHERE level = 'tampered'")).length).toBe(0);
  });
});

interface Planted {
  provider: string;
  channel: string;
  credential: string;
  post: string;
  variant: string;
  operation: string;
}

// A channel with one post, one variant and one operation of the author U.editor, as admission leaves them.
async function plantOperation(state: string, nextAttempt: string): Promise<Planted> {
  const provider = `notice-${randomUUID().slice(0, 8)}`;
  const [channel] = await rows(
    `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
     VALUES ($1, $2, 'profile', $2, $2, 'connected') RETURNING id`,
    [WA, provider],
  );
  const [credential] = await rows(
    `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv,
       ciphertext, auth_tag, wrap_iv, wrap_tag, wrapped_dek)
     VALUES ($1, $2, 1, 'channel_token', 1, 'k1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06') RETURNING id`,
    [WA, channel?.id],
  );
  return admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
        [WA, U.editor],
      )
    ).rows[0].id as string;
    const version = (
      await client.query(
        `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
         VALUES ($1, $2, 1, 'scheduled', '{"version":1}'::jsonb, decode(repeat('ab', 32), 'hex'), $3) RETURNING id`,
        [WA, post, U.editor],
      )
    ).rows[0].id as string;
    const variant = (
      await client.query(
        `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, due_at)
         VALUES ($1, $2, $3, 'in_progress', $4, now() - interval '5 minutes') RETURNING id`,
        [WA, post, channel?.id, version],
      )
    ).rows[0].id as string;
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
       VALUES ($1, $2, $3, $4, 'publish.' || $4, 'publish', $5, 'none', 'S', now() - interval '5 minutes',
         now() - $6::interval, now() + interval '2 hours', $7, $8, decode(repeat('ab', 32), 'hex'), $9, 60, 1)
       RETURNING id`,
      [WA, variant, channel?.id, provider, state, nextAttempt, `notice-${randomUUID()}`, version, U.editor],
    );
    await client.query("COMMIT");
    return {
      provider,
      channel: channel?.id,
      credential: credential?.id as string,
      post,
      variant,
      operation: made.rows[0].id as string,
    };
  });
}

const arabicAdmin = () =>
  admin((client) =>
    client.query(
      "INSERT INTO app.user_profiles (user_id, locale) VALUES ($1, 'ar') ON CONFLICT (user_id) DO UPDATE SET locale = 'ar'",
      [U.admin],
    ),
  );

describe("who gets a notice, and in which language", () => {
  let planted: Planted;
  beforeAll(async () => {
    planted = await plantOperation("needs_human", "4 minutes");
    await arabicAdmin();
  });

  const recipients = async (kind: string, subject: string) =>
    (
      await exec(LEDGER, "worker", "SELECT user_id, email, locale FROM app.notice_recipients($1, $2, $3)", [
        WA,
        kind,
        subject,
      ])
    ).rows;

  // [kind, which planted id is the subject, users who get it, users who must not]
  const WHO: [string, keyof Planted, string[], string[]][] = [
    ["token_expiry", "credential", [U.owner, U.admin], [U.editor, U.approver, U.viewer, U.bOwner]],
    ["reconnect_deadline", "credential", [U.owner, U.admin], [U.editor, U.approver, U.viewer, U.bOwner]],
    ["needs_human", "operation", [U.editor, U.owner, U.admin], [U.approver, U.viewer, U.bOwner]],
    ["unverified", "operation", [U.editor, U.owner, U.admin], [U.approver, U.viewer, U.bOwner]],
    ["held_media", "variant", [U.editor], [U.owner, U.admin, U.approver, U.viewer, U.bOwner]],
    ["drafts_day_30", "post", [U.editor], [U.owner, U.admin, U.approver, U.viewer, U.bOwner]],
  ];
  it.each(WHO)("%s goes to its recipients only", async (kind, subject, expected, never) => {
    const got = await recipients(kind, planted[subject]);
    const ids = got.map((row) => row.user_id);
    expect(ids).toEqual(expect.arrayContaining(expected));
    for (const user of never) expect(ids).not.toContain(user);
    for (const row of got) expect(row.email).toBe(EMAILS[row.user_id as string]);
  });

  it("a profile with locale ar reads ar, and no profile or a null locale reads en", async () => {
    const got = await recipients("token_expiry", planted.credential);
    expect(got.find((row) => row.user_id === U.admin)?.locale).toBe("ar");
    expect(got.find((row) => row.user_id === U.owner)?.locale).toBe("en");
  });
});

describe("what a notice mail may carry", () => {
  it("drops a token or any key it does not know, in every form", async () => {
    const canary = "canary-notice-token-1";
    const subject = randomUUID();
    const made = await exec(
      LEDGER,
      "worker",
      "SELECT app.notice_create($1, $2, 'token_expiry', $3, '14d', $4::jsonb) AS made",
      [
        WA,
        U.viewerOrgAdmin,
        subject,
        JSON.stringify({ name: "Channel", access_token: canary, link: canary }),
      ],
    );
    expect(made.error).toBeUndefined();
    const [mail] = await rows("SELECT vars::text AS vars FROM app.email_outbox WHERE recipient = $1", [
      EMAILS[U.viewerOrgAdmin],
    ]);
    const forms = [
      canary,
      encodeURIComponent(canary),
      Buffer.from(canary).toString("hex"),
      Buffer.from(canary).toString("base64"),
      JSON.stringify(canary).slice(1, -1),
    ];
    for (const form of forms) expect(mail?.vars).not.toContain(form);
  });
});

describe("how long a notification is kept", () => {
  it("purge_expired removes a notification older than 90 days and keeps a younger one", async () => {
    const plant = (level: string, age: string) =>
      rows(
        `INSERT INTO app.notifications (workspace_id, user_id, kind, subject_id, level, created_at)
         VALUES ($1, $2, 'token_expiry', $3, $4, now() - $5::interval)`,
        [WA, U.admin, randomUUID(), level, age],
      );
    await plant("retained-old", "91 days");
    await plant("retained-young", "89 days");
    const [purged] = (await db.pool("worker").query("SELECT removed FROM app.purge_expired('app.notifications')"))
      .rows;
    expect(Number(purged?.removed)).toBeGreaterThanOrEqual(1);
    const left = await rows("SELECT level FROM app.notifications WHERE level LIKE 'retained-%'");
    expect(left.map((row) => row.level)).toEqual(["retained-young"]);
  });
});

describe("the language of a notice", () => {
  beforeAll(arabicAdmin);

  it("the mail of a new notice is written in the recipient's language", async () => {
    const subject = randomUUID();
    await create({ subject, user: U.admin, kind: "token_expiry", level: "1d" });
    await create({ subject, user: U.owner, kind: "token_expiry", level: "1d" });
    const sent = await rows(
      "SELECT recipient, locale FROM app.email_outbox WHERE template = 'token_expiry' AND recipient IN ($1, $2)",
      [EMAILS[U.admin], EMAILS[U.owner]],
    );
    expect(Object.fromEntries(sent.map((row) => [row.recipient, row.locale]))).toEqual({
      [EMAILS[U.admin] as string]: "ar",
      [EMAILS[U.owner] as string]: "en",
    });
  });

  it("the locale column accepts en, ar and null and refuses anything else", async () => {
    const set = (value: string | null) =>
      admin((client) =>
        client.query("UPDATE app.user_profiles SET locale = $2 WHERE user_id = $1", [U.admin, value]),
      );
    await expect(set("en")).resolves.toBeDefined();
    await expect(set(null)).resolves.toBeDefined();
    await expect(set("fr")).rejects.toMatchObject({ code: "23514" });
    await set("ar");
  });
});

describe("the schema after disconnect and notices", () => {
  it("the claim skips an operation whose channel is not connected", async () => {
    const { provider, channel, operation } = await plantOperation("pending", "4 minutes");
    const claim = () =>
      exec(LEDGER, "worker", "SELECT id FROM app.claim_operations($1, 5, 'skip-owner')", [
        `publish.${provider}`,
      ]);
    await rows(
      "UPDATE app.channels SET connection_state = 'disconnected', disconnected_at = now() WHERE id = $1",
      [channel],
    );
    expect((await claim()).rows).toEqual([]);
    await rows(
      "UPDATE app.channels SET connection_state = 'connected', disconnected_at = NULL WHERE id = $1",
      [channel],
    );
    expect((await claim()).rows.map((row) => row.id)).toEqual([operation]);
  });

  it("a credential can be in the revoking state", async () => {
    const [channel] = await rows(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name, connection_state)
       VALUES ($1, 'revoking-check', 'profile', 'revoking-check', 'revoking-check', 'connected') RETURNING id`,
      [WA],
    );
    await rows(
      `INSERT INTO app.channel_credentials (workspace_id, channel_id, generation, kind, format_version, key_id, iv, ciphertext,
         auth_tag, wrap_iv, wrap_tag, wrapped_dek, state)
       VALUES ($1, $2, 1, 'channel_token', 1, 'k1', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', 'revoking')`,
      [WA, channel?.id],
    );
    expect(
      (await rows("SELECT state FROM app.channel_credentials WHERE channel_id = $1", [channel?.id]))[0]
        ?.state,
    ).toBe("revoking");
  });

  it("channels no longer carry last_reauth_notice, which the notifications key replaces", async () => {
    expect(
      await rows(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'channels' AND column_name = 'last_reauth_notice'",
      ),
    ).toEqual([]);
  });
});
