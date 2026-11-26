import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOrganization, seedWorkspace, signedUser } from "../../support/tenancy.js";
import { type Fixture, PASSWORD, startFixture, tokenOf } from "./harness.js";

// The mail's language comes from the request; the account, if any, never sets it.
const ARABIC = { "accept-language": "ar-EG,ar;q=0.9,en;q=0.8" };
const signUp = (fx: Fixture, email: string) =>
  fx.request("/api/auth/sign-up/email", {
    body: { name: "Test", email, password: PASSWORD },
    headers: ARABIC,
  });
const users = (fx: Fixture, email: string) =>
  fx.admin(async (client) =>
    Number((await client.query('SELECT count(*) AS n FROM auth."user" WHERE email = $1', [email])).rows[0].n),
  );

async function plantInvitation(fx: Fixture, email: string, invitedBy: string): Promise<void> {
  const organization = await seedOrganization(fx, invitedBy);
  const workspace = await seedWorkspace(fx, organization);
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, (SELECT id FROM app.roles WHERE workspace_id IS NULL AND key = 'editor'),
         sha256(convert_to($2, 'UTF8')), $3, now() + interval '1 day')`,
      [workspace, email, invitedBy],
    ),
  );
}

describe("a closed instance", () => {
  let fx: Fixture;
  let founder: { id: string; cookie: string };
  let founderEmail: string;
  beforeAll(async () => {
    fx = await startFixture({ signupOpen: false });
    // No instance admin exists yet, so this first sign-up is open; its verification makes the user the owner.
    founder = await signedUser(fx, "gate-founder");
    founderEmail = (
      await fx.admin((client) => client.query('SELECT email FROM auth."user" WHERE id = $1', [founder.id]))
    ).rows[0].email;
    await plantInvitation(fx, "gate-invited-1@example.test", founder.id);
    await fx.admin((client) =>
      client.query(
        `INSERT INTO auth."user" (name, email, email_verified) VALUES ('Existing', 'gate-existing-1@example.test', true)`,
      ),
    );
    await plantInvitation(fx, "gate-existing-1@example.test", founder.id);
  });
  afterAll(() => fx.close());

  it.each([
    ["an uninvited new address", "gate-uninvited-1@example.test", 0, "signup_closed_notice"],
    ["an invited new address", "gate-invited-1@example.test", 1, "verify_email"],
    ["an existing uninvited account", "", 1, "signup_closed_notice"],
    [
      "an invited address that already has an account",
      "gate-existing-1@example.test",
      1,
      "existing_account_notice",
    ],
  ])(
    "creates no user for an uninvited address, answers it exactly as an invited one and mails it in the request's language: %s",
    async (_title, address, userCount, template) => {
      const email = address === "" ? founderEmail : address;
      const mailsBefore = (await fx.mails(email)).length;
      const answer = await signUp(fx, email);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ user: { name: "Test", email, emailVerified: false } });
      expect(answer.headers.getSetCookie()).toEqual([]);
      expect(await users(fx, email)).toBe(userCount);
      const after = await fx.mails(email);
      expect(after.length - mailsBefore).toBe(1);
      expect([after[0]?.template, after[0]?.locale]).toEqual([template, "ar"]);
    },
  );

  it("signUpEmail called in process, bypassing the mount, creates no user", async () => {
    const email = "gate-bypass-1@example.test";
    const run = fx.auth.library.api.signUpEmail({ body: { name: "Test", email, password: PASSWORD } });
    await expect(run).rejects.toThrow();
    expect(await users(fx, email)).toBe(0);
  });
});

describe("a fresh instance", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture({ signupOpen: false });
  });
  afterAll(() => fx.close());

  it("lets two concurrent first sign-ups through, makes exactly one founder, then closes", async () => {
    const emails = ["gate-race-1@example.test", "gate-race-2@example.test"];
    const answers = await Promise.all(emails.map((email) => signUp(fx, email)));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await Promise.all(emails.map((email) => users(fx, email)))).toEqual([1, 1]);
    const mails = await Promise.all(emails.map((email) => fx.mails(email)));
    await Promise.all(
      mails.map(([mail]) => fx.request("/api/auth/verify-email", { body: { token: tokenOf(mail) } })),
    );
    const founders = await fx.admin(async (client) =>
      Number((await client.query("SELECT count(*) AS n FROM app.instance_admins")).rows[0].n),
    );
    expect(founders).toBe(1);
    await signUp(fx, "gate-race-3@example.test");
    expect(await users(fx, "gate-race-3@example.test")).toBe(0);
  });
});
