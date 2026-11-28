import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, type Fixture, PASSWORD, startFixture, tokenOf } from "./harness.js";

// The language of the mail a person gets is written when the account is made, from the language of the request, and
// again at each sign-in, because there is no profile call yet through which a language switcher could write it.
let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const localeOf = async (email: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT p.locale FROM app.user_profiles p JOIN auth."user" u ON u.id = p.user_id WHERE u.email = $1`,
          [email],
        )
      ).rows[0]?.locale as string | undefined,
  );
const language = (value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { "accept-language": value };
const signUp = (email: string, accept?: string) =>
  fx.request("/api/auth/sign-up/email", {
    body: { name: "Test", email, password: PASSWORD },
    headers: language(accept),
  });
const signIn = (email: string, accept?: string) =>
  fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD }, headers: language(accept) });
async function verified(email: string, accept?: string): Promise<void> {
  expect((await signUp(email, accept)).status).toBe(200);
  const [mail] = await fx.mails(email);
  expect((await fx.request("/api/auth/verify-email", { body: { token: tokenOf(mail) } })).status).toBe(200);
}

describe("the language written at sign-up", () => {
  it.each([
    ["ar", "ar"],
    ["ar-EG,en;q=0.8", "ar"],
    ["en-GB,ar;q=0.9", "en"],
    ["fr, de", "en"],
    [undefined, "en"],
  ])("a request in %j gives the account the language %s", async (accept, expected) => {
    const email = `locale-up-${String(accept).replaceAll(/\W/g, "").toLowerCase()}@example.test`;
    expect((await signUp(email, accept)).status).toBe(200);
    expect(await localeOf(email)).toBe(expected);
  });

  it("an address that already has an account keeps its language when someone signs up with it again", async () => {
    const email = "locale-again@example.test";
    await signUp(email, "ar");
    await signUp(email, "en");
    expect(await localeOf(email)).toBe("ar");
  });
});

describe("the language written at sign-in", () => {
  it("follows the request of each sign-in, since no profile call exists", async () => {
    const email = "locale-in@example.test";
    await verified(email, "en");
    expect(await localeOf(email)).toBe("en");
    expect(cookieOf(await signIn(email, "ar"))).not.toBe("");
    expect(await localeOf(email)).toBe("ar");
    expect(cookieOf(await signIn(email, "en-US"))).not.toBe("");
    expect(await localeOf(email)).toBe("en");
  });

  it("a refused sign-in changes nothing", async () => {
    const email = "locale-refused@example.test";
    await verified(email, "ar");
    const refused = await fx.request("/api/auth/sign-in/email", {
      body: { email, password: "wrong-password-1234" },
      headers: language("en"),
    });
    expect(cookieOf(refused)).toBe("");
    expect(await localeOf(email)).toBe("ar");
  });
});
