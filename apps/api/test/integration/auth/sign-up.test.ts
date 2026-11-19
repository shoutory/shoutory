import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, type Fixture, PASSWORD, startFixture, tokenOf } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const signUp = (email: string, password = PASSWORD) =>
  fx.request("/api/auth/sign-up/email", { body: { name: "Test", email, password } });
const signIn = (email: string, password = PASSWORD) =>
  fx.request("/api/auth/sign-in/email", { body: { email, password } });
const count = (sql: string) => fx.admin(async (client) => Number((await client.query(sql)).rows[0].n));

describe("sign-up", () => {
  it("re-registering an unverified email does not hijack the account and answers like a new sign-up", async () => {
    const first = await signUp("hijack-1@example.test", "victim-password-1");
    const second = await signUp("hijack-1@example.test", "attacker-password-1");
    const fresh = await signUp("hijack-2@example.test", "other-password-1");
    // The answers carry the same fields and no token; only the echoed email differs.
    const shape = async (answer: Response) => {
      const body = (await answer.json()) as { user: Record<string, unknown> };
      return {
        status: answer.status,
        fields: Object.keys(body.user).sort(),
        verified: body.user.emailVerified,
      };
    };
    const expected = await shape(first);
    expect(await shape(second)).toEqual(expected);
    expect(await shape(fresh)).toEqual(expected);
    expect(await count(`SELECT count(*) AS n FROM auth."user" WHERE email = 'hijack-1@example.test'`)).toBe(
      1,
    );
    // Neither password opens a session; the account is unverified.
    for (const password of ["victim-password-1", "attacker-password-1"]) {
      const answer = await signIn("hijack-1@example.test", password);
      expect(cookieOf(answer)).toBe("");
      expect([403, 401]).toContain(answer.status);
    }
    const mails = await fx.mails("hijack-1@example.test");
    expect(mails.map((mail) => mail.template).sort()).toEqual(["existing_account_notice", "verify_email"]);
    // The notice points at the sign-in page; the verification link is the SPA page with the token in the fragment.
    const byTemplate = Object.fromEntries(mails.map((mail) => [mail.template, mail.link]));
    expect(byTemplate.existing_account_notice).toBe("https://app.example.test/auth/sign-in");
    expect(byTemplate.verify_email).toMatch(/^https:\/\/app\.example\.test\/auth\/verify#token=[^&?]+$/);
    // The library's per-attempt info line carries the email; it is never written.
    expect(fx.logged.join("")).not.toContain("hijack-1@example.test");
  });

  it("signs up under the auth role only: the application role cannot read the account it created", async () => {
    await signUp("roles-1@example.test");
    expect(await count(`SELECT count(*) AS n FROM auth."user" WHERE email = 'roles-1@example.test'`)).toBe(1);
    await expect(fx.db.pool("app").query('SELECT 1 FROM auth."user"')).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("email verification", () => {
  it("a sign-up needs the mailed verification before a session is usable", async () => {
    await signUp("verify-1@example.test");
    const refused = await signIn("verify-1@example.test");
    expect([refused.status, cookieOf(refused)]).toEqual([403, ""]);
    const [mail] = await fx.mails("verify-1@example.test");
    expect(mail?.link).toMatch(/^https:\/\/app\.example\.test\/auth\/verify#token=/);
    const verified = await fx.request("/api/auth/verify-email", { body: { token: tokenOf(mail) } });
    expect(verified.status).toBe(200);
    expect(cookieOf(await signIn("verify-1@example.test"))).not.toBe("");
  });

  it("a bad token on the verify POST answers 400 link_unusable in our envelope", async () => {
    const answer = await fx.request("/api/auth/verify-email", { body: { token: "not-a-token-1" } });
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("link_unusable");
  });
});

describe("the instance owner", () => {
  it("a replayed verification POST changes nothing and claims no second owner", async () => {
    await fx.signedIn("owner-1@example.test");
    await fx.signedIn("owner-2@example.test");
    const [mail] = await fx.mails("owner-2@example.test");
    const replay = await fx.request("/api/auth/verify-email", { body: { token: tokenOf(mail) } });
    expect(replay.status).toBe(200);
    const admins = await fx.admin(
      async (client) =>
        (
          await client.query(
            `SELECT u.email, a.granted_by FROM app.instance_admins a JOIN auth."user" u ON u.id = a.user_id`,
          )
        ).rows,
    );
    // verify-1 was the first verified user of this database, so it is the only owner.
    expect(admins).toEqual([{ email: "verify-1@example.test", granted_by: null }]);
  });
});

describe("the instance owner's claim", () => {
  it("a second verified user is not owner, whatever ran before", async () => {
    const fx2 = await startFixture();
    try {
      await fx2.signedIn("first-owner-1@example.test");
      await fx2.signedIn("second-user-1@example.test");
      const admins = await fx2.admin(
        async (client) =>
          (
            await client.query(
              `SELECT u.email FROM app.instance_admins a JOIN auth."user" u ON u.id = a.user_id`,
            )
          ).rows,
      );
      expect(admins).toEqual([{ email: "first-owner-1@example.test" }]);
    } finally {
      await fx2.close();
    }
  });

  it("a first user whose claim failed at verification becomes owner at the next sign-in", async () => {
    const fx2 = await startFixture();
    try {
      await fx2.request("/api/auth/sign-up/email", {
        body: { name: "T", email: "stranded-1@example.test", password: PASSWORD },
      });
      // The state a failed claim leaves: verified, and no admin row.
      await fx2.admin((client) => client.query(`UPDATE auth."user" SET email_verified = true`));
      const answer = await fx2.request("/api/auth/sign-in/email", {
        body: { email: "stranded-1@example.test", password: PASSWORD },
      });
      expect(answer.status).toBe(200);
      const owners = await fx2.admin(async (client) =>
        Number(
          (await client.query("SELECT count(*) AS n FROM app.instance_admins WHERE granted_by IS NULL"))
            .rows[0].n,
        ),
      );
      expect(owners).toBe(1);
    } finally {
      await fx2.close();
    }
  });
});

// After the owner rows: this user verifies, so it must not be the first verified user of the shared fixture.
describe("a long password", () => {
  it("the policy's longest password, 128 astral characters of 256 UTF-16 units, can sign in", async () => {
    const email = "astral-1@example.test";
    const astral = "😀".repeat(128);
    expect((await signUp(email, astral)).status).toBe(200);
    await fx.request("/api/auth/verify-email", { body: { token: tokenOf((await fx.mails(email))[0]) } });
    expect((await signIn(email, astral)).status).toBe(200);
  });
});
