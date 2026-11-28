import { randomUUID } from "node:crypto";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sendDueNotices } from "../../src/jobs/notices/notices.js";
import { createLogger } from "../../src/logging/logger.js";
import { TEMPLATES } from "../../src/mail/templates.js";
import { leaks } from "../support/canary.js";
import { connectChannel, tokenOfAccount } from "../support/ledger-credentials.js";
import { seedWorkspace } from "../support/ledger-seed.js";

// The notice job reads what is due through one definer, and creates each notice through the one definer that writes the
// card and its mail together. These tests run it against the database with real people, roles and languages.
const env = readTestEnv();
let db: TestDatabase;
let ws: string;
const people = { owner: "", admin: "", editor: "" };
type Person = keyof typeof people;
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const run = () => sendDueNotices({ pool: db.pool("worker"), logger });

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  ws = await admin((client) => seedWorkspace(client));
  await admin(async (client) => {
    people.owner = (
      await client.query("SELECT user_id FROM app.workspace_members WHERE workspace_id = $1", [ws])
    ).rows[0].user_id;
    for (const [name, role] of [
      ["admin", "admin"],
      ["editor", "editor"],
    ] as const) {
      const id = randomUUID();
      people[name] = id;
      await client.query(
        'INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [id, `notice-${name}`, `${id}@example.test`],
      );
      await client.query(
        `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
         VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = $3))`,
        [ws, id, role],
      );
    }
    await client.query("INSERT INTO app.user_profiles (user_id, locale) VALUES ($1, 'ar')", [people.admin]);
  });
});
afterAll(() => db.drop());

const nameOf = (id: string) => (Object.entries(people).find(([, value]) => value === id) ?? ["nobody"])[0];
const noticesOf = async (subject: string) =>
  (
    await rows(
      "SELECT user_id, kind, level FROM app.notifications WHERE subject_id = $1 ORDER BY created_at, level, user_id",
      [subject],
    )
  ).map((row) => ({ who: nameOf(row.user_id), kind: row.kind as string, level: row.level as string }));
const levelsOf = async (subject: string) => [...new Set((await noticesOf(subject)).map((n) => n.level))];
const whoOf = async (subject: string) => [...new Set((await noticesOf(subject)).map((n) => n.who))].sort();
const mailsFor = (template: string, person: Person) =>
  rows(
    `SELECT o.locale, o.vars, o.link_ciphertext FROM app.email_outbox o JOIN auth."user" u ON u.email = o.recipient
     WHERE o.template = $1 AND u.id = $2 ORDER BY o.created_at`,
    [template, people[person]],
  );

interface Channel {
  state?: string;
  tokenIn?: string;
  deadlineIn?: string;
  nickname?: string;
}
async function plantChannel(o: Channel = {}): Promise<string> {
  const account = `n-${randomUUID().slice(0, 8)}`;
  const channel = await connectChannel(db.pool("worker"), {
    workspace: ws,
    provider: "notice-provider",
    account,
  });
  await rows(
    `UPDATE app.channels SET connection_state = $2, nickname = $3, reconnect_deadline = now() + $4::interval
     WHERE id = $1`,
    [channel, o.state ?? "connected", o.nickname ?? "Shop page", o.deadlineIn ?? null],
  );
  await rows(
    "UPDATE app.channel_credentials SET access_expires_at = now() + $2::interval WHERE channel_id = $1",
    [channel, o.tokenIn ?? null],
  );
  return channel;
}
const setExpiry = (channel: string, left: string) =>
  rows("UPDATE app.channel_credentials SET access_expires_at = now() + $2::interval WHERE channel_id = $1", [
    channel,
    left,
  ]);
const setDeadline = (channel: string, left: string) =>
  rows("UPDATE app.channels SET reconnect_deadline = now() + $2::interval WHERE id = $1", [channel, left]);

interface Planted {
  channel: string;
  post: string;
  variant: string;
  operation: string;
}
async function plantTarget(
  o: { state?: string; schedule?: string; dueAgo?: string; media?: string } = {},
): Promise<Planted> {
  const channel = await plantChannel();
  return admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id, status) VALUES ($1, 'user', $2, 'scheduled') RETURNING id",
        [ws, people.editor],
      )
    ).rows[0].id as string;
    const snapshot = { version: 1, resolved: { media: o.media ? { [o.media]: "ab" } : {} } };
    const version = (
      await client.query(
        `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
         VALUES ($1, $2, 1, 'scheduled', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
        [ws, post, JSON.stringify(snapshot), people.editor],
      )
    ).rows[0].id as string;
    const variant = (
      await client.query(
        `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state, frozen_version_id, due_at)
         VALUES ($1, $2, $3, $4, $5, now() - $6::interval) RETURNING id`,
        [ws, post, channel, o.schedule ?? "in_progress", version, o.dueAgo ?? "5 minutes"],
      )
    ).rows[0].id as string;
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const made = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, next_attempt_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token, next_escalation_at, settled_at)
       VALUES ($1, $2, $3, 'notice-provider', 'publish.notice-provider', 'publish', $4, 'none', 'S',
         now() - interval '5 minutes', now() - interval '1 minute', now() + interval '2 hours', $5, $6,
         decode(repeat('ab', 32), 'hex'), $7, 60, 1, now() - interval '1 minute', $8)
       RETURNING id`,
      [
        ws,
        variant,
        channel,
        o.state ?? "needs_human",
        `notice-${randomUUID()}`,
        version,
        people.editor,
        o.state === "cancelled" ? new Date() : null,
      ],
    );
    await client.query("COMMIT");
    return { channel, post, variant, operation: made.rows[0].id as string };
  });
}
const asset = async (state: string) => {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'held.mp4', 'video/mp4',
       'upload', $3::uuid, $4, decode(md5($1::text) || md5($2::text), 'hex'))`,
    [id, ws, people.editor, state],
  );
  return id;
};

// [template, plants its subject and returns the subject id, the people who get it]
const KINDS: [string, () => Promise<string>, Person[]][] = [
  ["token_expiry", async () => plantChannel({ tokenIn: "5 days" }), ["owner", "admin"]],
  [
    "reconnect_deadline",
    async () => plantChannel({ state: "needs_reconnect", deadlineIn: "5 days" }),
    ["owner", "admin"],
  ],
  [
    "needs_human",
    async () => (await plantTarget({ state: "needs_human" })).operation,
    ["editor", "owner", "admin"],
  ],
  [
    "unverified",
    async () => (await plantTarget({ state: "unverified" })).operation,
    ["editor", "owner", "admin"],
  ],
  [
    "held_media",
    async () =>
      (await plantTarget({ schedule: "scheduled", dueAgo: "1 minute", media: await asset("processing") }))
        .variant,
    ["editor"],
  ],
  [
    "drafts_day_30",
    async () => {
      const planted = await plantTarget({ state: "cancelled" });
      await rows(
        "UPDATE app.channels SET connection_state = 'disconnected', reconnect_deadline = now() - interval '1 hour' WHERE id = $1",
        [planted.channel],
      );
      return planted.post;
    },
    ["editor"],
  ],
];

describe("who gets each notice, and in which language", () => {
  it.each(KINDS)(
    "%s goes to its recipients once, each mail in their language, and never again",
    async (kind, plant, expected) => {
      const subject = await plant();
      await run();
      expect(await whoOf(subject)).toEqual([...expected].sort());
      for (const person of expected) {
        const [mail] = await mailsFor(kind, person);
        expect([mail?.locale, mail?.link_ciphertext]).toEqual([person === "admin" ? "ar" : "en", null]);
        expect(TEMPLATES[kind as keyof typeof TEMPLATES].vars.safeParse(mail?.vars).success).toBe(true);
      }
      const before = (await noticesOf(subject)).length;
      await run();
      await run();
      expect((await noticesOf(subject)).length).toBe(before);
      for (const person of expected) expect(await mailsFor(kind, person)).toHaveLength(1);
    },
  );
});

describe("token expiry notices fire at 14, 7 and 1 days", () => {
  it("one level at each crossing, by card and by mail, to the Owner and the Admin only", async () => {
    const channel = await plantChannel({ tokenIn: "13 days" });
    const seen: string[][] = [];
    for (const left of ["13 days", "6 days", "20 hours"]) {
      await setExpiry(channel, left);
      await run();
      seen.push(await levelsOf(channel));
    }
    expect(seen).toEqual([["14d"], ["14d", "7d"], ["14d", "7d", "1d"]]);
    expect(await whoOf(channel)).toEqual(["admin", "owner"]);
    expect((await mailsFor("token_expiry", "owner")).length).toBeGreaterThanOrEqual(3);
    const mails = await rows(
      `SELECT o.vars FROM app.email_outbox o JOIN auth."user" u ON u.email = o.recipient
       WHERE o.template = 'token_expiry' AND u.id = $1 ORDER BY o.created_at DESC LIMIT 3`,
      [people.owner],
    );
    expect(mails.map((mail) => [mail.vars.level, mail.vars.days, mail.vars.name])).toEqual([
      ["1d", 1, "Shop page"],
      ["7d", 7, "Shop page"],
      ["14d", 14, "Shop page"],
    ]);
  });

  it.each([
    ["5 days", ["7d"]],
    ["10 hours", ["1d"]],
    ["12 days", ["14d"]],
  ])(
    "a token first seen with %s left gets only the smallest crossed level %j, once",
    async (left, levels) => {
      const channel = await plantChannel({ tokenIn: left });
      await run();
      await run();
      expect(await levelsOf(channel)).toEqual(levels);
      expect((await noticesOf(channel)).filter((n) => n.who === "owner")).toHaveLength(1);
    },
  );

  it("a token with a refresh token, a token that expired and a channel that is not connected give no notice", async () => {
    const refreshing = await plantChannel({ tokenIn: "3 days" });
    await rows("UPDATE app.channel_credentials SET refresh_token_digest = 'digest-1' WHERE channel_id = $1", [
      refreshing,
    ]);
    const expired = await plantChannel({ tokenIn: "-1 hour" });
    const away = await plantChannel({ tokenIn: "3 days", state: "needs_reconnect" });
    await run();
    for (const channel of [refreshing, expired, away]) expect(await noticesOf(channel)).toEqual([]);
  });
});

describe("reconnect deadline reminders fire at 14, 7 and 1 days", () => {
  it("one level at each crossing and none for a connected channel", async () => {
    const channel = await plantChannel({ state: "disconnected", deadlineIn: "13 days" });
    const connected = await plantChannel({ state: "connected", deadlineIn: "3 days" });
    const seen: string[][] = [];
    for (const left of ["13 days", "6 days", "10 hours"]) {
      await setDeadline(channel, left);
      await run();
      seen.push(await levelsOf(channel));
    }
    expect(seen).toEqual([["14d"], ["14d", "7d"], ["14d", "7d", "1d"]]);
    expect(await noticesOf(connected)).toEqual([]);
  });

  it("a deadline first seen inside the 7-day window gets only the 7-day reminder", async () => {
    const channel = await plantChannel({ state: "needs_reconnect", deadlineIn: "4 days" });
    await run();
    expect(await levelsOf(channel)).toEqual(["7d"]);
  });
});

describe("escalation of a post that needs a person", () => {
  const nextIn = async (operation: string) =>
    (
      await rows(
        "SELECT extract(epoch FROM next_escalation_at - clock_timestamp()) / 86400 AS days FROM app.operations WHERE id = $1",
        [operation],
      )
    )[0]?.days as number;
  const due = (operation: string) =>
    rows("UPDATE app.operations SET next_escalation_at = now() - interval '1 second' WHERE id = $1", [
      operation,
    ]);

  it("notices at entry, after 1 day, 3 days, 7 days and then weekly, and stops at resolution", async () => {
    const { operation } = await plantTarget({ state: "needs_human" });
    const gaps: number[] = [];
    const levels: string[][] = [];
    for (let step = 0; step < 5; step++) {
      await due(operation);
      await run();
      levels.push(await levelsOf(operation));
      gaps.push(Math.round(await nextIn(operation)));
    }
    expect(levels.map((l) => l.length)).toEqual([1, 2, 3, 4, 5]);
    expect(levels[4]).toEqual([
      "escalation_0",
      "escalation_1",
      "escalation_2",
      "escalation_3",
      "escalation_4",
    ]);
    expect(gaps).toEqual([1, 2, 4, 7, 7]);
    await admin(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE app.operations SET state = 'cancelled' WHERE id = $1", [operation]);
      await client.query("COMMIT");
    });
    await due(operation);
    await run();
    expect(await levelsOf(operation)).toHaveLength(5);
  });

  it("two jobs at once send one step", async () => {
    const { operation } = await plantTarget({ state: "unverified" });
    await Promise.all([run(), run(), run()]);
    expect(await levelsOf(operation)).toEqual(["escalation_0"]);
    expect((await noticesOf(operation)).filter((n) => n.who === "editor")).toHaveLength(1);
  });
});

describe("a post held for its media", () => {
  it("notifies its author in Arabic when the author's language is Arabic, with the channel named", async () => {
    await rows("UPDATE app.user_profiles SET locale = 'ar' WHERE user_id = $1", [people.admin]);
    await rows(
      "INSERT INTO app.user_profiles (user_id, locale) VALUES ($1, 'ar') ON CONFLICT (user_id) DO UPDATE SET locale = 'ar'",
      [people.editor],
    );
    try {
      const planted = await plantTarget({
        schedule: "scheduled",
        dueAgo: "1 minute",
        media: await asset("processing"),
      });
      await run();
      expect(await noticesOf(planted.variant)).toEqual([
        { who: "editor", kind: "held_media", level: "held" },
      ]);
      const mail = (await mailsFor("held_media", "editor")).at(-1);
      expect(mail?.locale).toBe("ar");
      const text = TEMPLATES.held_media.render("ar", "", mail?.vars);
      expect(`${text.subject}${text.text}`).toMatch(/\p{Script=Arabic}/u);
      expect(text.text).toContain("Shop page");
    } finally {
      await rows("UPDATE app.user_profiles SET locale = NULL WHERE user_id = $1", [people.editor]);
    }
  });

  it.each([
    ["ready", "1 minute"],
    ["processing", "-10 minutes"],
    ["processing", "5 hours"],
  ])("a %s medium due %s ago gives no notice", async (state, ago) => {
    const planted = await plantTarget({ schedule: "scheduled", dueAgo: ago, media: await asset(state) });
    await run();
    expect(await noticesOf(planted.variant)).toEqual([]);
  });
});

describe("what a notice carries", () => {
  it("holds no token of the channel and no key beyond the few the copy knows, in any form", async () => {
    const account = `canary-${randomUUID().slice(0, 8)}`;
    const channel = await connectChannel(db.pool("worker"), {
      workspace: ws,
      provider: "notice-provider",
      account,
    });
    await setExpiry(channel, "2 days");
    await run();
    expect(await levelsOf(channel)).toEqual(["7d"]);
    const stored = await rows(
      `SELECT (SELECT string_agg(n.vars::text, ' ') FROM app.notifications n WHERE n.subject_id = $1) AS notices,
              (SELECT string_agg(o.vars::text || o.recipient, ' ') FROM app.email_outbox o
                WHERE o.template = 'token_expiry' AND o.vars ->> 'name' = $2) AS mails`,
      [channel, account],
    );
    const [kept] = stored;
    expect(kept?.notices).toBeTruthy();
    expect(leaks(`${kept?.notices} ${kept?.mails}`, [tokenOfAccount(account)])).toEqual([]);
    const keys = new Set(
      (
        await rows("SELECT jsonb_object_keys(vars) AS k FROM app.notifications WHERE subject_id = $1", [
          channel,
        ])
      ).map((row) => row.k),
    );
    expect([...keys].every((key) => ["name", "provider", "days", "reason"].includes(key as string))).toBe(
      true,
    );
  });
});
