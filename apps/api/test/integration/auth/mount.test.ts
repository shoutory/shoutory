import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_PATHS } from "../../../src/auth/paths.js";
import { cookieOf, type Fixture, PASSWORD, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const deadUrl = (): string => {
  const url = new URL(fx.db.url("auth"));
  url.port = "1";
  return url.toString();
};
const errorOf = async (answer: Response) =>
  ((await answer.json()) as { error: { code: string; requestId: string } }).error;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// One valid-looking body per non-GET path, so a refusal is the guard's and not the schema's.
const SAMPLE: Record<string, unknown> = {
  "/api/auth/sign-up/email": { name: "Test", email: "table-1@example.test", password: PASSWORD },
  "/api/auth/sign-in/email": { email: "table-1@example.test", password: PASSWORD },
  "/api/auth/sign-out": {},
  "/api/auth/send-verification-email": { email: "table-1@example.test" },
  "/api/auth/verify-email": { token: "token-sample-1" },
  "/api/auth/sessions/revoke": { id: "00000000-0000-7000-8000-000000000001" },
  "/api/auth/sessions/revoke-others": {},
  "/api/auth/profile": { name: "Test" },
  "/api/auth/verify-password": { password: PASSWORD },
  "/api/auth/change-password": { currentPassword: PASSWORD, newPassword: "another-password-5678" },
  "/api/auth/request-password-reset": { email: "table-1@example.test" },
  "/api/auth/reset-password": { token: "token-sample-1", newPassword: "another-password-5678" },
  "/api/auth/two-factor/enable": { password: PASSWORD },
  "/api/auth/two-factor/disable": { password: PASSWORD },
  "/api/auth/two-factor/get-totp-uri": { password: PASSWORD },
  "/api/auth/two-factor/generate-backup-codes": { password: PASSWORD },
  "/api/auth/two-factor/verify-totp": { code: "123456" },
  "/api/auth/two-factor/verify-backup-code": { code: "backup-sample-1" },
};
const nonGet = AUTH_PATHS.filter((row) => row.method !== "GET");

describe("the Better-Auth mount guards", () => {
  it("has non-GET rows to guard", () => {
    expect(nonGet.length).toBeGreaterThan(0);
  });

  it.each(nonGet.map((row) => [row.method, row.path]))(
    "%s %s refuses a cross-site origin, a missing X-Shoutory-Client header, and a cookie with a junk Bearer header",
    async (method, path) => {
      const body = SAMPLE[path as string];
      expect(body, `add a sample body for ${path}`).toBeDefined();
      const crossSite = await fx.request(path as string, {
        method: method as string,
        body,
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example.test" },
      });
      expect([crossSite.status, (await errorOf(crossSite)).code]).toEqual([403, "csrf_rejected"]);
      const noClient = await fx.request(path as string, {
        method: method as string,
        body,
        headers: { "x-shoutory-client": "" },
      });
      expect([noClient.status, (await errorOf(noClient)).code]).toEqual([403, "csrf_rejected"]);
      const cookie = await fx.signedIn("bearer-1@example.test");
      const bearer = await fx.request(path as string, {
        method: method as string,
        body,
        headers: { authorization: "Bearer junk-token-1", cookie, "x-shoutory-client": "" },
      });
      expect([bearer.status, (await errorOf(bearer)).code]).toEqual([401, "unauthenticated"]);
    },
  );
});

describe("the session cookie", () => {
  it("every Set-Cookie on a sign-in, refresh or sign-out is one __Host- cookie with Secure, Path=/ and no Domain", async () => {
    const cookie = await fx.signedIn("cookie-1@example.test");
    await fx.admin((client) =>
      client.query("UPDATE auth.session SET expires_at = now() + interval '5 days'"),
    );
    const answers = [
      await fx.request("/api/auth/sign-in/email", {
        body: { email: "cookie-1@example.test", password: PASSWORD },
      }),
      await fx.request("/api/auth/get-session", { headers: { cookie } }),
      await fx.request("/api/auth/sign-out", { body: {}, headers: { cookie } }),
    ];
    const lines = answers.flatMap((answer) => answer.headers.getSetCookie());
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(line).toMatch(/^__Host-[^=]+=/);
      expect(line).toMatch(/;\s*Secure/i);
      expect(line).toMatch(/;\s*Path=\/(;|$)/i);
      expect(line).toMatch(/;\s*HttpOnly/i);
      expect(line).not.toMatch(/;\s*Domain=/i);
    }
    expect(new Set(lines.map((line) => line.split("=")[0])).size).toBe(1);
    // Lax, a seven-day lifetime on the sign-in cookie, and no cookie of a feature we do not use.
    const signIn = lines[0] ?? "";
    expect(signIn).toMatch(/;\s*SameSite=Lax/i);
    expect(signIn).toMatch(/;\s*Max-Age=604800(;|$)/i);
    for (const line of lines) expect(line).not.toMatch(/dont_remember|session_data/);
  });

  it("a sign-out on a session aged past the update age leaves only the expiry cookie", async () => {
    const cookie = await fx.signedIn("cookie-2@example.test");
    await fx.admin((client) =>
      client.query("UPDATE auth.session SET expires_at = now() + interval '5 days'"),
    );
    const answer = await fx.request("/api/auth/sign-out", { body: {}, headers: { cookie } });
    expect(answer.status).toBe(200);
    const lines = answer.headers.getSetCookie();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Max-Age=0/i);
  });
});

describe("the client address", () => {
  it("a client-supplied X-Forwarded-For or internal header changes neither the login_ip key nor the stored ip_hmac", async () => {
    const peer = "192.0.2.201";
    const email = "ip-1@example.test";
    await fx.signedIn(email, peer);
    const keys = () =>
      fx.admin(
        async (client) =>
          (await client.query("SELECT key FROM app.rate_buckets WHERE scope = 'login_ip'")).rows.length,
      );
    const before = await keys();
    await fx.request("/api/auth/sign-in/email", {
      body: { email, password: PASSWORD },
      peer,
      headers: { "x-forwarded-for": "203.0.113.9", "x-shoutory-client-ip": "198.51.100.7" },
    });
    expect(await keys()).toBe(before);
    await fx.request("/api/auth/sign-in/email", { body: { email, password: PASSWORD }, peer: "192.0.2.202" });
    const hmacs = await fx.admin(async (client) =>
      (
        await client.query(
          'SELECT ip_hmac FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1',
          [email],
        )
      ).rows.map((row) => row.ip_hmac as string),
    );
    expect(hmacs.length).toBe(3);
    for (const value of hmacs) expect(value).toMatch(/^[0-9a-f]{64}$/);
    // Three sessions from two peers: the spoofed header did not make a third value.
    expect(new Set(hmacs).size).toBe(2);
  });
});

let mapUsers: Promise<void> | undefined;

describe("sign-in answers", () => {
  it("sign-in, sign-up and error answers carry one envelope and no token field, and the three failure answers are identical in status, body and headers; an unknown email spends its own bucket; timing within the band", async () => {
    const email = "uniform-1@example.test";
    await fx.signedIn(email);
    const attempt = async (who: string, password: string) => {
      const started = performance.now();
      const answer = await fx.request("/api/auth/sign-in/email", { body: { email: who, password } });
      return { answer, ms: performance.now() - started };
    };
    const buckets = () =>
      fx.admin(
        async (client) =>
          (await client.query("SELECT key FROM app.rate_buckets WHERE scope = 'login_account'")).rows.length,
      );
    const rowsBefore = await buckets();
    const unknown = await attempt("nobody-1@example.test", "wrong-password-1");
    expect(await buckets()).toBe(rowsBefore + 1);
    const wrong = await attempt(email, "wrong-password-1");
    const wrongMs = [wrong.ms];
    const unknownMs = [unknown.ms];
    for (let i = 0; i < 4; i++) {
      wrongMs.push((await attempt(email, "wrong-password-1")).ms);
      unknownMs.push((await attempt(`nobody-${i + 2}@example.test`, "wrong-password-1")).ms);
    }
    await fx.admin((client) =>
      client.query("UPDATE app.rate_buckets SET tokens = 0 WHERE scope = 'login_account'"),
    );
    const locked = await attempt(email, PASSWORD);
    const lockedMs = [locked.ms];
    for (let i = 0; i < 2; i++) lockedMs.push((await attempt(email, PASSWORD)).ms);
    const shape = async (answer: Response) => {
      const body = (await answer.json()) as { error: Record<string, unknown> };
      body.error.requestId = "x";
      const headers = [...answer.headers.entries()].filter(
        ([name]) => !["x-request-id", "date"].includes(name),
      );
      return { status: answer.status, body, headers };
    };
    const expected = await shape(wrong.answer);
    expect(expected.status).toBe(401);
    expect(JSON.stringify(expected.body)).not.toMatch(/token/i);
    expect(await shape(unknown.answer)).toEqual(expected);
    expect(await shape(locked.answer)).toEqual(expected);
    // An unknown or locked account still pays for a password hash.
    expect(median(unknownMs)).toBeGreaterThan(median(wrongMs) * 0.5);
    expect(median(lockedMs)).toBeGreaterThan(median(wrongMs) * 0.5);
  });
});

describe("the error map", () => {
  it.each([
    [
      "a wrong password",
      "/api/auth/sign-in/email",
      { email: "map-1@example.test", password: "wrong-password-1" },
      401,
      "invalid_credentials",
    ],
    [
      "an unverified account with the right password",
      "/api/auth/sign-in/email",
      { email: "map-2@example.test", password: PASSWORD },
      403,
      "email_not_verified",
    ],
    [
      "a path Better-Auth has but we disabled",
      "/api/auth/change-email",
      { newEmail: "x@example.test" },
      404,
      "not_found",
    ],
  ])(
    "%s answers the one envelope with its own code and no cookie",
    async (_name, path, body, status, code) => {
      mapUsers ??= (async () => {
        await fx.signedIn("map-1@example.test");
        await fx.request("/api/auth/sign-up/email", {
          body: { name: "T", email: "map-2@example.test", password: PASSWORD },
        });
      })();
      await mapUsers;
      const answer = await fx.request(path, { body });
      expect([answer.status, (await errorOf(answer)).code]).toEqual([status, code]);
      expect(cookieOf(answer)).toBe("");
    },
  );
});

describe("a database outage", () => {
  it("on a session route answers 503 with Retry-After and keeps the row", async () => {
    const cookie = await fx.signedIn("outage-1@example.test");
    const count = () =>
      fx.admin(async (client) =>
        Number((await client.query("SELECT count(*) AS n FROM auth.session")).rows[0].n),
      );
    const before = await count();
    const answer = await fx.request("/api/auth/sessions", { headers: { cookie } }, fx.appOn(deadUrl()));
    expect([answer.status, (await errorOf(answer)).code, answer.headers.get("retry-after")]).toEqual([
      503,
      "service_unavailable",
      "5",
    ]);
    expect(await count()).toBe(before);
    expect((await fx.request("/api/auth/sessions", { headers: { cookie } })).status).toBe(200);
  });

  it("on sign-in answers 503 with Retry-After, never 401 or 500", async () => {
    const answer = await fx.request(
      "/api/auth/sign-in/email",
      { body: { email: "outage-2@example.test", password: PASSWORD } },
      fx.appOn(deadUrl()),
    );
    expect([answer.status, answer.headers.get("retry-after")]).toEqual([503, "5"]);
  });
});
