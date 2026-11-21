import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, Jar, PASSWORD, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());
afterEach(() => fx.hibp.breached.clear());

const NEW_PASSWORD = "another-password-5678";
interface ErrorBody {
  error: { code: string; details?: { reason?: string } };
}
const post = (path: string, body: object, jar: Jar) =>
  fx.request(`/api/auth/${path}`, { body, headers: jar.header });
const errorOf = async (answer: Response) => ((await answer.json()) as ErrorBody).error;
const status = (jar: Jar) => fx.request("/api/auth/two-factor/status", { headers: jar.header });

describe("the two-factor status", () => {
  it("answers off with no count for a person without a second factor", async () => {
    const jar = new Jar(await fx.signedIn("status-off-1@example.test"));
    const answer = await status(jar);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ data: { enabled: false, recovery_codes_left: null } });
  });

  it("counts 10 codes after enrolment and 9 after one is used, and the answer holds no code value", async () => {
    const email = "status-on-1@example.test";
    const enrolled = await fx.enrolled(email);
    const first = await status(enrolled.jar);
    const text = await first.clone().text();
    expect(await first.json()).toEqual({ data: { enabled: true, recovery_codes_left: 10 } });
    for (const code of enrolled.backupCodes) expect(text).not.toContain(code);
    expect(text).not.toContain(enrolled.secret);
    const challenge = await fx.challenged(email);
    const used = await post(
      "two-factor/verify-backup-code",
      { code: enrolled.backupCodes[0] },
      challenge.jar,
    );
    expect(used.status).toBe(200);
    expect(await (await status(enrolled.jar)).json()).toEqual({
      data: { enabled: true, recovery_codes_left: 9 },
    });
  });
});

describe("changing the password", () => {
  it("a wrong current password says so by its reason, a breached new one by its own", async () => {
    const jar = new Jar(await fx.signedIn("change-refused-1@example.test"));
    const wrong = await post(
      "change-password",
      { currentPassword: "wrong-password-0000", newPassword: NEW_PASSWORD },
      jar,
    );
    const wrongError = await errorOf(wrong);
    expect([wrong.status, wrongError.code, wrongError.details]).toEqual([
      400,
      "validation_failed",
      { reason: "current_password_wrong" },
    ]);
    fx.hibp.breached.add("breached-password-1234");
    const breached = await post(
      "change-password",
      { currentPassword: PASSWORD, newPassword: "breached-password-1234" },
      jar,
    );
    const breachedError = await errorOf(breached);
    expect([breached.status, breachedError.code, breachedError.details]).toEqual([
      400,
      "validation_failed",
      { reason: "password_breached" },
    ]);
  });

  it("keeps this device signed in on its new session, ends the old one, and asks for the password again at the next sensitive call", async () => {
    const email = "change-keeps-1@example.test";
    const oldCookie = await fx.signedIn(email);
    const jar = new Jar(oldCookie);
    const changed = await post(
      "change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      jar,
    );
    expect(changed.status).toBe(200);
    jar.add(changed);
    expect((await fx.request("/api/auth/get-session", { headers: jar.header })).status).toBe(200);
    expect((await fx.request("/api/auth/get-session", { headers: { cookie: oldCookie } })).status).toBe(401);
    const next = await post("two-factor/enable", { password: NEW_PASSWORD }, jar);
    expect([next.status, (await errorOf(next)).code]).toEqual([403, "step_up_required"]);
  });
});

describe("the session list", () => {
  it("holds at most 100 live sessions, newest first, and keeps the current one even when it is the oldest", async () => {
    const email = "list-bound-1@example.test";
    const jar = new Jar(await fx.signedIn(email));
    // 110 sessions newer than the current one, inserted oldest first (a list in row order would cut off the newest),
    // and one expired session that is the newest of all.
    const expiredId = await fx.admin(async (client) => {
      await client.query(
        `INSERT INTO auth.session (expires_at, token, created_at, user_id)
         SELECT now() + interval '1 day', 'bulk-session-token-' || g, now() + (g || ' seconds')::interval,
                (SELECT id FROM auth."user" WHERE email = $1)
         FROM generate_series(1, 110) AS g`,
        [email],
      );
      const expired = await client.query(
        `INSERT INTO auth.session (expires_at, token, created_at, user_id)
         VALUES (now() - interval '1 minute', 'expired-session-token', now() + interval '1 hour',
                 (SELECT id FROM auth."user" WHERE email = $1))
         RETURNING id`,
        [email],
      );
      return expired.rows[0].id as string;
    });
    const answer = await fx.request("/api/auth/sessions", { headers: jar.header });
    const { data } = (await answer.json()) as {
      data: Array<{ id: string; createdAt: string; current: boolean }>;
    };
    expect(data).toHaveLength(100);
    expect(data.at(-1)?.current).toBe(true);
    expect(data.some((item) => item.id === expiredId)).toBe(false);
    const times = data.map((item) => Date.parse(item.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
