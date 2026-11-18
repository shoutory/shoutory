import { SealedSecret } from "@shoutory/core/crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pepperDigest } from "../../../src/auth/throttle.js";
import { type Fixture, Jar, ORIGIN, PASSWORD, PEPPER, startFixture, tokenOf, totpAt } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());
// A failing row must not leave the fake breached or down for the next one.
afterEach(() => {
  fx.hibp.breached.clear();
  fx.hibp.down = false;
  fx.hibp.body = undefined;
});

const NEW_PASSWORD = "another-password-5678";
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;
const post = (path: string, body: object, jar?: Jar) =>
  fx.request(`/api/auth/${path}`, { body, ...(jar ? { headers: jar.header } : {}) });
const methods = (email: string) =>
  fx.admin(async (client) =>
    (
      await client.query(
        `SELECT s.method FROM app.session_step_ups s JOIN auth."user" u ON u.id = s.user_id
           WHERE u.email = $1 ORDER BY s.at`,
        [email],
      )
    ).rows.map((row) => row.method as string),
  );
const ageStepUps = (email: string, interval: string) =>
  fx.admin((client) =>
    client.query(
      `UPDATE app.session_step_ups SET at = clock_timestamp() - $2::interval
       WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [email, interval],
    ),
  );

describe("step-up", () => {
  it("a step_up path answers step_up_required at 11 minutes and passes at 9; sign-in, verify-password and a verified TOTP each record it", async () => {
    const email = "stepup-1@example.test";
    const jar = new Jar(await fx.signedIn(email));
    expect(await methods(email)).toEqual(["password"]);
    await ageStepUps(email, "9 minutes");
    expect((await post("two-factor/enable", { password: PASSWORD }, jar)).status).toBe(200);
    await ageStepUps(email, "11 minutes");
    const stale = await post("two-factor/enable", { password: PASSWORD }, jar);
    expect([stale.status, await codeOf(stale)]).toEqual([403, "step_up_required"]);
    expect((await post("verify-password", { password: PASSWORD }, jar)).status).toBe(200);
    expect(await methods(email)).toEqual(["password", "password"]);
    expect((await post("two-factor/enable", { password: PASSWORD }, jar)).status).toBe(200);
    const enrolled = await fx.enrolled("stepup-2@example.test");
    expect(await methods(enrolled.email)).toEqual(["password", "totp"]);
  });
});

describe("a session holder's password checks spend the account's login bucket", () => {
  const key = (email: string) => pepperDigest(new SealedSecret(PEPPER), "login_account", email);
  const tokens = (email: string) =>
    fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT tokens FROM app.rate_buckets WHERE scope = 'login_account' AND key = $1",
            [key(email)],
          )
        ).rows[0]?.tokens as number | undefined,
    );
  const setTokens = (email: string, value: number) =>
    fx.admin((client) =>
      client.query(
        `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('login_account', $1, $2)
         ON CONFLICT (scope, key) DO UPDATE SET tokens = $2, refilled_at = clock_timestamp()`,
        [key(email), value],
      ),
    );

  it.each([
    ["verify-password", (password: string) => ({ password })],
    ["change-password", (password: string) => ({ currentPassword: password, newPassword: NEW_PASSWORD })],
    ["two-factor/enable", (password: string) => ({ password })],
  ])(
    "%s: a wrong password spends the bucket, an empty bucket answers 429 and a success refunds it",
    async (path, body) => {
      const email = `session-bucket-${path.replace("/", "-")}@example.test`;
      const jar = new Jar(await fx.signedIn(email));
      await setTokens(email, 5);
      expect((await post(path, body("wrong-password-1"), jar)).status).toBe(400);
      expect(Math.round((await tokens(email)) ?? 0)).toBe(4);
      await setTokens(email, 0);
      const refused = await post(path, body(PASSWORD), jar);
      expect([refused.status, await codeOf(refused)]).toEqual([429, "too_many_requests"]);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      await setTokens(email, 5);
      expect((await post(path, body(PASSWORD), jar)).status).toBe(200);
      expect(Math.round((await tokens(email)) ?? 0)).toBe(100);
    },
  );
});

describe("sessions end when the credentials change", () => {
  const alive = async (session: Jar) =>
    (await fx.request("/api/auth/get-session", { headers: session.header })).status === 200;
  // Each row: the user holds the current session and a second one; the change must end the second.
  const signedInTwice = async (email: string) => {
    const jar = new Jar(await fx.signedIn(email));
    return { jar, second: new Jar().add(await post("sign-in/email", { email, password: PASSWORD })) };
  };
  const twiceWithTotp = async (email: string) => {
    const enrolled = await fx.enrolled(email);
    const challenge = await fx.challenged(email);
    const code = totpAt(enrolled.secret, 1);
    const signedIn = await post("two-factor/verify-totp", { code }, challenge.jar);
    return { jar: enrolled.jar, second: new Jar().add(signedIn) };
  };

  it.each([
    [
      "change-password",
      signedInTwice,
      "change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    ],
    ["enabling the second factor", signedInTwice, "two-factor/enable", { password: PASSWORD }],
    ["disabling the second factor", twiceWithTotp, "two-factor/disable", { password: PASSWORD }],
  ])("%s revokes every other session", async (_name, setup, path, body) => {
    const { jar, second } = await setup(`revoke-${path.replace("/", "-")}@example.test`);
    expect(await alive(second)).toBe(true);
    expect((await post(path, body, jar)).status).toBe(200);
    expect(await alive(second)).toBe(false);
  });
});

describe("password reset", () => {
  it("a reset request answers alike for a known and an unknown email; the link is sealed to the SPA fragment, the row is hashed, the GET changes nothing and the POST consumes it once", async () => {
    const email = "reset-1@example.test";
    await fx.signedIn(email);
    const known = await post("request-password-reset", { email });
    const unknown = await post("request-password-reset", { email: "reset-nobody@example.test" });
    expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
    const [mail] = await fx.mails(email);
    expect(mail?.template).toBe("reset_password");
    expect(mail?.link.startsWith(`${ORIGIN}/auth/reset#token=`)).toBe(true);
    const token = tokenOf(mail);
    const rows = () =>
      fx.admin(async (client) => (await client.query("SELECT identifier FROM auth.verification")).rows);
    const before = await rows();
    expect(JSON.stringify(before)).not.toContain(token);
    // The library's own GET of the link is disabled; the SPA page that opens it changes nothing either.
    expect((await fx.request(`/api/auth/reset-password/${token}`)).status).toBe(404);
    expect(await rows()).toEqual(before);
    const reset = await post("reset-password", { token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    const replay = await post("reset-password", { token, newPassword: "yet-another-password-9" });
    expect(replay.status).toBe(400);
    expect((await post("sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("a reset or change-password with a breached password is refused through our hook and the reset token stays unused", async () => {
    const email = "breached-1@example.test";
    const jar = new Jar(await fx.signedIn(email));
    await post("request-password-reset", { email });
    const token = tokenOf((await fx.mails(email))[0]);
    fx.hibp.breached.add("breached-password-1234");
    const refusals = [
      await post("reset-password", { token, newPassword: "breached-password-1234" }),
      await post(
        "change-password",
        { currentPassword: PASSWORD, newPassword: "breached-password-1234" },
        jar,
      ),
    ];
    for (const refusal of refusals)
      expect([refusal.status, await codeOf(refusal)]).toEqual([400, "validation_failed"]);
    expect((await post("reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });
});

const signUpWhileDown = async (email: string) => {
  fx.hibp.down = true;
  const signUp = await post("sign-up/email", { name: "Test", email, password: PASSWORD });
  fx.hibp.down = false;
  expect(signUp.status).toBe(200);
  await post("verify-email", { token: tokenOf((await fx.mails(email))[0]) });
};
const due = (email: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT p.password_recheck_at FROM app.user_profiles p JOIN auth."user" u ON u.id = p.user_id WHERE u.email = $1`,
          [email],
        )
      ).rows[0]?.password_recheck_at ?? null,
  );
// The mark of the second-factor row is planted: the outage-at-sign-up chain is the plain row's.
const markedSecondFactor = async (email: string) => {
  await fx.enrolled(email);
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.user_profiles (user_id, password_recheck_at)
       SELECT id, now() FROM auth."user" WHERE email = $1
       ON CONFLICT (user_id) DO UPDATE SET password_recheck_at = now()`,
      [email],
    ),
  );
};

describe("the breached-password re-check at sign-in", () => {
  it.each([
    ["a plain sign-in", "recheck-hit-1@example.test", signUpWhileDown],
    ["the first step of a second-factor sign-in", "recheck-hit-2@example.test", markedSecondFactor],
  ])(
    "an HIBP outage marks a re-check; a hit at the next sign-in answers password_reset_required and leaves no session or challenge cookie: %s",
    async (_name, email, setup) => {
      await setup(email);
      expect(await due(email)).not.toBeNull();
      const sessions = await fx.sessionCount(email);
      fx.hibp.breached.add(PASSWORD);
      const answer = await post("sign-in/email", { email, password: PASSWORD });
      expect([answer.status, await codeOf(answer)]).toEqual([403, "password_reset_required"]);
      expect(answer.headers.getSetCookie().filter((line) => /^__Host-[^=]+=[^;]/.test(line))).toEqual([]);
      expect(await fx.sessionCount(email)).toBe(sessions);
    },
  );

  it("a clean re-check signs in and clears the mark; an outage during the re-check keeps it and accepts", async () => {
    const email = "recheck-clean-1@example.test";
    await signUpWhileDown(email);
    fx.hibp.down = true;
    expect((await post("sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    fx.hibp.down = false;
    expect(await due(email)).not.toBeNull();
    expect((await post("sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    expect(await due(email)).toBeNull();
  });

  it.each([
    ["an empty body", ""],
    ["a body that is not a range answer", "<html>maintenance</html>"],
  ])(
    "a 200 answer that is %s is no range answer: the sign-in accepts and keeps the mark",
    async (_name, body) => {
      const email = `recheck-body-${body.length}@example.test`;
      await signUpWhileDown(email);
      fx.hibp.body = body;
      expect((await post("sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      expect(await due(email)).not.toBeNull();
    },
  );
});
