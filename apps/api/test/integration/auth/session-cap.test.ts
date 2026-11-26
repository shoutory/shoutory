import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, PASSWORD, startFixture } from "./harness.js";

// The library's rolling expiry may push `expires_at` past the cap, which the read ignores. The injected clock moves
// the "now" of the cap only: the library keeps the real clock, so the rows the cap judges keep a live `expires_at`.
let fx: Fixture;
let clock: number | undefined;
beforeAll(async () => {
  fx = await startFixture({ now: () => clock ?? Date.now() });
}, 60_000);
afterAll(() => fx.close());
afterEach(() => {
  clock = undefined;
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SESSIONS = "/api/auth/sessions";
const listed = (cookie: string) => fx.request(SESSIONS, { headers: { cookie } });
const sessionRow = (email: string) =>
  fx.admin(async (client) => {
    const found = await client.query(
      `SELECT s.id, s.created_at, s.expires_at FROM auth.session s JOIN auth."user" u ON u.id = s.user_id
       WHERE u.email = $1`,
      [email],
    );
    return found.rows[0] as { id: string; created_at: Date; expires_at: Date } | undefined;
  });
// A count by user would miss a replaced row, so this checks the very row the test signed in with.
const stored = (id: string | undefined) =>
  fx.admin(
    async (client) => (await client.query("SELECT 1 FROM auth.session WHERE id = $1", [id])).rowCount === 1,
  );
// Pins the creation (and the last update) of the user's session; its expiry stays a week after the real sign-in.
const pin = (email: string, createdAt: Date, updatedAt: Date = createdAt) =>
  fx.admin((client) =>
    client.query(
      `UPDATE auth.session SET created_at = $2, updated_at = $3
       WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email, createdAt, updatedAt],
    ),
  );

// The age is measured against the injected clock from a fixed creation instant. The two alive rows are the edges the
// cap must not cross (29 days 23 hours, and one millisecond short of 30 days); the other two are the refusal.
const AGES = [
  { label: "29 days 23 hours", age: 29 * DAY + 23 * HOUR, alive: true },
  { label: "30 days minus 1 millisecond", age: 30 * DAY - 1, alive: true },
  { label: "exactly 30 days", age: 30 * DAY, alive: false },
  { label: "30 days 1 minute", age: 30 * DAY + 60_000, alive: false },
  // An age that cannot be computed (an unusable clock) counts as over the cap: the check fails closed.
  { label: "NaN milliseconds", age: Number.NaN, alive: false },
];

describe("the 30-day session cap (security floor)", () => {
  it.each(AGES)(
    "a session $label old is alive: $alive",
    async ({ label, age, alive }) => {
      const email = `cap-${label.replaceAll(/\W+/g, "-")}@example.test`.toLowerCase();
      const cookie = await fx.signedIn(email);
      const id = (await sessionRow(email))?.id;
      const created = new Date(Date.now() - 1000);
      await pin(email, created);
      clock = created.getTime() + age;
      const answer = await listed(cookie);
      expect(answer.status).toBe(alive ? 200 : 401);
      expect(await fx.sessionCount(email)).toBe(alive ? 1 : 0);
      expect(await stored(id)).toBe(alive);
    },
    30_000,
  );

  it("a refresh at 29 days 23 hours pushes the expiry past the cap and the next read, 2 hours later, is still refused", async () => {
    const email = "cap-refresh-1@example.test";
    const cookie = await fx.signedIn(email);
    const id = (await sessionRow(email))?.id;
    const created = new Date(Date.now() - (29 * DAY + 23 * HOUR));
    await pin(email, created, new Date(Date.now() - 2 * DAY));
    const refreshed = await listed(cookie);
    expect(refreshed.status).toBe(200);
    const row = await sessionRow(email);
    expect((row?.expires_at.getTime() ?? 0) > created.getTime() + 30 * DAY).toBe(true);
    clock = Date.now() + 2 * HOUR;
    const refused = await listed(cookie);
    expect(refused.status).toBe(401);
    expect(await fx.sessionCount(email)).toBe(0);
    expect(await stored(id)).toBe(false);
  }, 30_000);
});

describe("an over-cap cookie (security floor)", () => {
  it("an over-cap cookie with a valid backup code is refused and records neither a step-up nor an audit row", async () => {
    const email = "cap-backup-1@example.test";
    const enrolled = await fx.enrolled(email);
    const id = (await sessionRow(email))?.id;
    await pin(email, new Date(Date.now() - 31 * DAY));
    const answer = await fx.request("/api/auth/two-factor/verify-backup-code", {
      body: { code: enrolled.backupCodes[0] },
      headers: enrolled.jar.header,
    });
    expect(answer.status).toBe(401);
    const recorded = await fx.admin(async (client) => {
      const methods = await client.query(
        `SELECT s.method FROM app.session_step_ups s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
        [email],
      );
      const audits = await client.query(
        `SELECT l.metadata->>'method' AS method FROM app.audit_logs l JOIN auth."user" u ON u.id::text = l.actor_ref
         WHERE u.email = $1 AND l.action = 'auth.step_up'`,
        [email],
      );
      return { methods: methods.rows.map((row) => row.method), audits: audits.rows.map((row) => row.method) };
    });
    expect(recorded.methods).not.toContain("backup_code");
    expect(recorded.audits).not.toContain("backup_code");
    expect(await fx.sessionCount(email)).toBe(0);
    expect(await stored(id)).toBe(false);
  }, 30_000);
});

describe("a read that is not the person's activity (security floor)", () => {
  const PEEK = { "x-shoutory-session-peek": "1" };
  const expiry = async (email: string) => (await sessionRow(email))?.expires_at.getTime() ?? 0;

  it.each([
    ["a peek leaves the expiry where it was", PEEK, false],
    ["a plain read rolls it", {}, true],
  ])(
    "%s",
    async (_name, extra, rolled) => {
      const email = `peek-${rolled ? "plain" : "peek"}-1@example.test`;
      const cookie = await fx.signedIn(email);
      await pin(email, new Date(Date.now() - 2 * DAY));
      await fx.admin((client) =>
        client.query(
          `UPDATE auth.session SET expires_at = now() + interval '1 hour'
         WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
          [email],
        ),
      );
      const before = await expiry(email);
      const answer = await fx.request("/api/auth/get-session", { headers: { cookie, ...extra } });
      expect(answer.status).toBe(200);
      expect((await expiry(email)) > before).toBe(rolled);
    },
    30_000,
  );

  it("a peek over the cap is refused and deletes the session", async () => {
    const email = "peek-cap-1@example.test";
    const cookie = await fx.signedIn(email);
    const id = (await sessionRow(email))?.id;
    await pin(email, new Date(Date.now() - 31 * DAY));
    const answer = await fx.request("/api/auth/get-session", { headers: { cookie, ...PEEK } });
    expect(answer.status).toBe(401);
    expect(await stored(id)).toBe(false);
  }, 30_000);
});

describe("what a session near the cap reports (security floor)", () => {
  it("a refreshed session's expiry is clamped to the cap, and the list drops a session over it", async () => {
    const email = "cap-report-1@example.test";
    const cookie = await fx.signedIn(email);
    await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
    const ids = await fx.admin(async (client) =>
      (
        await client.query(
          `SELECT s.id FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1
           ORDER BY s.created_at`,
          [email],
        )
      ).rows.map((row) => row.id as string),
    );
    const [live, over] = ids;
    const created = new Date(Date.now() - (29 * DAY + 23 * HOUR));
    await fx.admin(async (client) => {
      const set = "UPDATE auth.session SET created_at = $2, updated_at = $3 WHERE id = $1";
      await client.query(set, [live, created, new Date(Date.now() - 2 * DAY)]);
      await client.query(set, [over, new Date(Date.now() - 31 * DAY), new Date()]);
    });
    const shown = (await (await fx.request("/api/auth/get-session", { headers: { cookie } })).json()) as {
      data: { session: { expiresAt: string } };
    };
    const reported = new Date(shown.data.session.expiresAt).getTime();
    expect(reported).toBeLessThanOrEqual(created.getTime() + 30 * DAY);
    const list = (await (await listed(cookie)).json()) as { data: { id: string }[] };
    expect(list.data.map((item) => item.id)).toEqual([live]);
  }, 30_000);
});
