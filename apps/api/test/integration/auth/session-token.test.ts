import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieOf, type Fixture, SECRET, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const rawToken = (cookie: string): string =>
  decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
const storedTokens = () =>
  fx.admin(async (client) => (await client.query("SELECT token, expires_at FROM auth.session")).rows);
const tokensOf = (email: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT s.token, s.expires_at FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
          [email],
        )
      ).rows,
  );

// A session cookie as the library signs it: the value, a dot and the base64 HMAC-SHA-256 of the value.
const signed = (value: string): string =>
  `__Host-shoutory_session=${encodeURIComponent(`${value}.${createHmac("sha256", SECRET).update(value).digest("base64")}`)}`;

describe("a forged session cookie", () => {
  it("a cookie signed with the server secret whose value is a stored digest is refused", async () => {
    const cookie = await fx.signedIn("forged-1@example.test");
    const genuine = await fx.request("/api/auth/sessions", { headers: { cookie: signed(rawToken(cookie)) } });
    expect(genuine.status).toBe(200);
    const [row] = await fx.admin(
      async (client) =>
        (
          await client.query(
            `SELECT s.token FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
            ["forged-1@example.test"],
          )
        ).rows,
    );
    expect(row.token).toMatch(/^h1:/);
    const forged = await fx.request("/api/auth/sessions", { headers: { cookie: signed(row.token) } });
    expect(forged.status).toBe(401);
  });
});

describe("session tokens at rest", () => {
  it("after a sliding refresh the cookie still holds the raw token and the row only the digest", async () => {
    const cookie = await fx.signedIn("sliding-1@example.test");
    const raw = rawToken(cookie);
    expect(raw).not.toBe("");
    const before = (await tokensOf("sliding-1@example.test"))[0];
    // Age the session so the next read is past the update age and the library slides it.
    await fx.admin((client) =>
      client.query("UPDATE auth.session SET expires_at = now() + interval '5 days'"),
    );
    const answer = await fx.request("/api/auth/get-session", { headers: { cookie } });
    expect(answer.status).toBe(200);
    const refreshed = cookieOf(answer);
    expect(refreshed).not.toBe("");
    expect(rawToken(refreshed)).toBe(raw);
    const [row] = await tokensOf("sliding-1@example.test");
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(row.token).toMatch(/^h1:[0-9a-f]{64}$/);
    expect(row.token).not.toContain(raw);
    expect(before.token).toMatch(/^h1:/);
  });

  it("no auth.session row holds the cookie token, and our session list answers no token field", async () => {
    const cookie = await fx.signedIn("at-rest-1@example.test");
    const raw = rawToken(cookie);
    for (const row of await storedTokens()) expect(row.token).not.toContain(raw);
    const listed = await fx.request("/api/auth/sessions", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(raw);
    const { data } = JSON.parse(text) as { data: Record<string, unknown>[] };
    expect(data.length).toBeGreaterThan(0);
    for (const item of data) {
      expect(item).toHaveProperty("id");
      expect(item).not.toHaveProperty("token");
    }
  });
});
