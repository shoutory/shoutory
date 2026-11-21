import { SealedSecret } from "@shoutory/core/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pepperDigest } from "../../../src/auth/throttle.js";
import { type Enrolled, type Fixture, Jar, PASSWORD, PEPPER, startFixture, totpAt } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const verifyTotp = (jar: Jar, code: string, extra: object = {}) =>
  fx.request("/api/auth/two-factor/verify-totp", { body: { code, ...extra }, headers: jar.header });
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;
const bucketKey = (scope: string, subject: string) => pepperDigest(new SealedSecret(PEPPER), scope, subject);
const userId = (email: string) =>
  fx.admin(
    async (client) => (await client.query('SELECT id FROM auth."user" WHERE email = $1', [email])).rows[0].id,
  );

// One enrolled user for the tests that only sign in, so each of them does not pay for a sign-up, a verification and
// an enrolment (every password check is a memory-hard hash).
let shared: Promise<Enrolled> | undefined;
const sharedUser = () => {
  shared ??= fx.enrolled("shared-2fa-1@example.test");
  return shared;
};

/** Enrols a user, signs in through the challenge with the next code and answers the verification's status. */
async function signInWithTotp(email: string): Promise<number> {
  const enrolled = await fx.enrolled(email);
  const { jar } = await fx.challenged(email);
  return (await verifyTotp(jar, totpAt(enrolled.secret, 1))).status;
}

describe("the TOTP code is single use and the second factor is throttled", () => {
  it("a TOTP code is accepted once: a replay answers 429 with Retry-After and a wrong guess costs no bucket", async () => {
    const email = "totp-replay-1@example.test";
    const enrolled = await fx.enrolled(email);
    const code = totpAt(enrolled.secret, 1);
    const first = await fx.challenged(email);
    const wrong = await verifyTotp(first.jar, "000000");
    expect(wrong.status).toBe(401);
    // The wrong guess did not spend the right code's bucket: the right code still signs in.
    expect((await verifyTotp(first.jar, code)).status).toBe(200);
    // A second-factor sign-in on an account that already had the factor revokes no other session.
    const here = await fx.request("/api/auth/get-session", { headers: enrolled.jar.header });
    expect(here.status).toBe(200);
    const second = await fx.challenged(email);
    const replay = await verifyTotp(second.jar, code);
    expect([replay.status, await codeOf(replay)]).toEqual([429, "too_many_requests"]);
    expect(Number(replay.headers.get("retry-after"))).toBeGreaterThan(0);
    // Key isolation: the spent code bucket of this user never refuses another user.
    expect(await signInWithTotp("totp-replay-2@example.test")).toBe(200);
  });

  it("a wrong-TOTP flood answers 429 after the two_factor limit and never refuses another user", async () => {
    const email = "totp-flood-1@example.test";
    await fx.enrolled(email);
    // The plugin ends a challenge after five wrong codes; the budget is the user's, across challenges.
    for (let round = 0; round < 2; round++) {
      const { jar } = await fx.challenged(email);
      for (let i = 0; i < 5; i++) await verifyTotp(jar, String(100_000 + round * 5 + i));
    }
    // The plugin's own lockout (ten failures) is a backstop: lift it, so the 429 below is our bucket's.
    await fx.admin((client) =>
      client.query("UPDATE auth.two_factor SET locked_until = NULL, failed_verification_count = 0"),
    );
    const { jar } = await fx.challenged(email);
    const flooded = await verifyTotp(jar, "999999");
    expect(flooded.status).toBe(429);
    expect(Number(flooded.headers.get("retry-after"))).toBeGreaterThan(0);
    // Key isolation: the emptied two_factor bucket of this user never refuses another user.
    const other = await sharedUser();
    const challenge = await fx.challenged(other.email);
    expect((await verifyTotp(challenge.jar, totpAt(other.secret, 1))).status).toBe(200);
    // Enrolling, four sign-ins and the shared user's enrolment are memory-hard hashes: the default limit is too short.
  }, 30_000);

  it("repeated reset requests answer 429 after the password_reset limit", async () => {
    const email = "reset-flood-1@example.test";
    const reset = () => fx.request("/api/auth/request-password-reset", { body: { email } });
    for (let i = 0; i < 5; i++) expect((await reset()).status).toBe(200);
    const sixth = await reset();
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("the backup code path and the disabled second-factor paths", () => {
  it("verify-backup-code answers 429 after the two_factor limit; send-otp and verify-otp answer our 404; trustDevice and disableSession are refused", async () => {
    const email = "backup-limit-1@example.test";
    const enrolled = await fx.enrolled(email);
    const { jar } = await fx.challenged(email);
    for (const body of [
      { code: "x", trustDevice: true },
      { code: "x", disableSession: true },
    ]) {
      const refused = await fx.request("/api/auth/two-factor/verify-backup-code", {
        body,
        headers: jar.header,
      });
      expect([refused.status, await codeOf(refused)]).toEqual([400, "validation_failed"]);
    }
    const trusted = await verifyTotp(jar, totpAt(enrolled.secret, 1), { trustDevice: true });
    expect(trusted.status).toBe(400);
    expect(trusted.headers.getSetCookie().join()).not.toContain("trust_device");
    for (const path of ["send-otp", "verify-otp"]) {
      const answer = await fx.request(`/api/auth/two-factor/${path}`, { body: {}, headers: jar.header });
      expect([answer.status, await codeOf(answer)]).toEqual([404, "not_found"]);
    }
    await fx.admin(async (client) =>
      client.query(
        `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('two_factor', $1, 0)
         ON CONFLICT (scope, key) DO UPDATE SET tokens = 0, refilled_at = clock_timestamp()`,
        [bucketKey("two_factor", await userId(email))],
      ),
    );
    const limited = await fx.request("/api/auth/two-factor/verify-backup-code", {
      body: { code: enrolled.backupCodes[0] },
      headers: jar.header,
    });
    expect(limited.status).toBe(429);
  });
});

describe("the second-factor challenge", () => {
  it("a sign-in with a second factor answers twoFactorRedirect with only __Host- cookies, the exact two-factor cookie name and no live session cookie", async () => {
    const { email } = await sharedUser();
    const { answer } = await fx.challenged(email);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ twoFactorRedirect: true });
    const lines = answer.headers.getSetCookie();
    const names = lines.map((line) => line.split("=")[0]);
    expect(names.every((name) => name?.startsWith("__Host-"))).toBe(true);
    const challenge = lines.find((line) => line.startsWith("__Host-shoutory_two_factor="));
    expect(challenge).toMatch(/Max-Age=600/i);
    expect(lines.some((line) => line.includes("__Secure-"))).toBe(false);
    const live = lines.filter((line) => /^__Host-shoutory_session=[^;]/.test(line));
    expect(live).toEqual([]);
  });

  it("the challenge branch refunds the account bucket in full and creates no owner claim", async () => {
    const { email } = await sharedUser();
    const key = bucketKey("login_account", email);
    await fx.admin(async (client) => {
      await client.query("DELETE FROM app.instance_admins");
      await client.query(
        `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('login_account', $1, 40)
         ON CONFLICT (scope, key) DO UPDATE SET tokens = 40, refilled_at = clock_timestamp()`,
        [key],
      );
    });
    expect((await fx.challenged(email)).answer.status).toBe(200);
    const [tokens, admins] = await fx.admin(async (client) => [
      (
        await client.query("SELECT tokens FROM app.rate_buckets WHERE scope = 'login_account' AND key = $1", [
          key,
        ])
      ).rows[0].tokens,
      Number((await client.query("SELECT count(*) FROM app.instance_admins")).rows[0].count),
    ]);
    expect([Math.round(tokens), admins]).toEqual([100, 0]);
  });
});

describe("the enrolment answers carry the secret once and nothing else does", () => {
  it("the enrolment paths are step_up and no-store; no /get-session or sign-in answer carries the TOTP URI or backup codes; a log canary finds neither", async () => {
    const enrolled = await sharedUser();
    const { email } = enrolled;
    expect(enrolled.enableAnswer.headers.get("cache-control")).toBe("no-store");
    await fx.admin((client) =>
      client.query(
        "UPDATE app.session_step_ups SET at = at - interval '11 minutes' WHERE user_id = (SELECT id FROM auth.\"user\" WHERE email = $1)",
        [email],
      ),
    );
    for (const [path, body] of [
      ["enable", { password: PASSWORD }],
      ["disable", { password: PASSWORD }],
      ["get-totp-uri", { password: PASSWORD }],
      ["generate-backup-codes", { password: PASSWORD }],
    ] as const) {
      const answer = await fx.request(`/api/auth/two-factor/${path}`, { body, headers: enrolled.jar.header });
      expect([path, answer.status, await codeOf(answer)]).toEqual([path, 403, "step_up_required"]);
    }
    const session = await fx.request("/api/auth/get-session", { headers: enrolled.jar.header });
    const signIn = await fx.challenged(email);
    const surfaces = [await session.text(), await signIn.answer.text(), fx.logged.join("")];
    for (const surface of surfaces) {
      expect(surface).not.toContain(enrolled.secret);
      expect(surface).not.toContain("otpauth");
      for (const code of enrolled.backupCodes) expect(surface).not.toContain(code);
    }
  });

  it("the TOTP secret and the backup codes are not stored in plain text", async () => {
    const enrolled = await sharedUser();
    const row = await fx.admin(
      async (client) =>
        (
          await client.query(
            'SELECT secret, backup_codes FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1',
            [enrolled.email],
          )
        ).rows[0],
    );
    expect(row.secret).not.toContain(enrolled.secret);
    for (const code of enrolled.backupCodes) expect(row.backup_codes).not.toContain(code);
  });
});

// What the setup page may tell the user: which sessions survive the two calls of an enrolment.
describe("an enrolment and its first code", () => {
  it("activating the second factor ends a session made during enrolment; enabling signs out the other devices and the first code keeps this device signed in", async () => {
    const email = "setup-sessions-1@example.test";
    const jar = new Jar(await fx.signedIn(email));
    const signIn = async () =>
      new Jar().add(await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } }));
    const alive = async (holder: Jar) =>
      (await fx.request("/api/auth/get-session", { headers: holder.header })).status === 200;
    const before = await signIn();
    const enable = await fx.request("/api/auth/two-factor/enable", {
      body: { password: PASSWORD },
      headers: jar.header,
    });
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const afterEnable = {
      sessions: await fx.sessionCount(email),
      here: await alive(jar),
      other: await alive(before),
    };
    const opened = await signIn();
    const secret = new URL(totpURI).searchParams.get("secret");
    if (!secret) throw new Error("the enable answer holds no secret");
    const verified = await verifyTotp(jar, totpAt(secret));
    const swapped = new Jar(jar.header.cookie).add(verified);
    const observed = {
      afterEnable,
      verifyStatus: verified.status,
      newCookie: verified.headers.getSetCookie().some((line) => line.startsWith("__Host-shoutory_session=")),
      sessions: await fx.sessionCount(email),
      oldCookieAlive: await alive(jar),
      thisDeviceAlive: await alive(swapped),
      openedBetweenAlive: await alive(opened),
    };
    expect(observed).toEqual({
      afterEnable: { sessions: 1, here: true, other: false },
      verifyStatus: 200,
      newCookie: true,
      sessions: 1,
      oldCookieAlive: false,
      thisDeviceAlive: true,
      openedBetweenAlive: false,
    });
  }, 30_000);
});
