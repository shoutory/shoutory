import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const nameOf = (email: string) =>
  fx.admin(
    async (client) =>
      (await client.query('SELECT name FROM auth."user" WHERE email = $1', [email])).rows[0]?.name as string,
  );
const rename = (cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  fx.request("/api/auth/profile", { body, headers: { cookie, ...headers } });
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;

describe("the profile route", () => {
  it("changes only the caller's name, and get-session then answers it", async () => {
    const caller = "profile-caller-1@example.test";
    const other = "profile-other-1@example.test";
    const cookie = await fx.signedIn(caller);
    await fx.signedIn(other);
    const otherBefore = await nameOf(other);
    const answer = await rename(cookie, { name: "Renamed Person" });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ data: { name: "Renamed Person" } });
    expect(await nameOf(caller)).toBe("Renamed Person");
    expect(await nameOf(other)).toBe(otherBefore);
    const session = await fx.request("/api/auth/get-session", { headers: { cookie } });
    const body = (await session.json()) as { data: { user: { name: string; email: string } } };
    expect([body.data.user.name, body.data.user.email]).toEqual(["Renamed Person", caller]);
  });

  it.each([
    ["an email", { name: "Fine Name", email: "taken-1@example.test" }],
    ["a verified flag", { name: "Fine Name", emailVerified: false }],
    ["any other key", { name: "Fine Name", role: "owner" }],
    ["an empty name", { name: "" }],
    ["a name of 101 characters", { name: "n".repeat(101) }],
    ["no name", {}],
    ["a name of spaces only", { name: "   " }],
    ["a name with a NUL", { name: "Ada\u0000Lovelace" }],
    ["a name with a bidi override", { name: "Ada‮evil" }],
  ])("refuses %s and changes nothing", async (_what, body) => {
    const email = "profile-refused-1@example.test";
    const cookie = await fx.signedIn(email);
    const before = await nameOf(email);
    const answer = await rename(cookie, body);
    expect([answer.status, await codeOf(answer)]).toEqual([400, "validation_failed"]);
    expect(await nameOf(email)).toBe(before);
  });

  it("answers 401 without a session and 403 without the client header", async () => {
    const email = "profile-guard-1@example.test";
    const cookie = await fx.signedIn(email);
    const before = await nameOf(email);
    const signedOut = await fx.request("/api/auth/profile", { body: { name: "No Cookie" } });
    expect([signedOut.status, await codeOf(signedOut)]).toEqual([401, "unauthenticated"]);
    const noClient = await rename(cookie, { name: "No Header" }, { "x-shoutory-client": "" });
    expect([noClient.status, await codeOf(noClient)]).toEqual([403, "csrf_rejected"]);
    expect(await nameOf(email)).toBe(before);
  });
});
