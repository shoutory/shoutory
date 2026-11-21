import { SealedSecret } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipSubject } from "../../../src/auth/throttle.js";
import { type Fixture, PASSWORD, PEPPER, startFixture } from "./harness.js";

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const pepper = new SealedSecret(PEPPER);
const bucketKey = (scope: string, subject: string) => pepperDigest(pepper, scope, subject);
const tokensOf = (scope: string, subject: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query("SELECT tokens FROM app.rate_buckets WHERE scope = $1 AND key = $2", [
          scope,
          bucketKey(scope, subject),
        ])
      ).rows[0]?.tokens as number | undefined,
  );
/** Empties a bucket as of now, so the next spend is refused with the bucket's own wait. */
const empty = (scope: string, subject: string) =>
  fx.admin((client) =>
    client.query(
      `INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ($1, $2, 0)
       ON CONFLICT (scope, key) DO UPDATE SET tokens = 0, refilled_at = clock_timestamp()`,
      [scope, bucketKey(scope, subject)],
    ),
  );
const signIn = (email: string, password: string, peer?: string) =>
  fx.request("/api/auth/sign-in/email", { body: { email, password }, ...(peer ? { peer } : {}) });
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;

describe("the account lockout", () => {
  it("the 101st failure locks the account, and the bucket refills over time", async () => {
    const email = "lockout-1@example.test";
    await fx.signedIn(email);
    for (let i = 0; i < 100; i++) expect((await signIn(email, "wrong-password-1")).status).toBe(401);
    const locked = await signIn(email, PASSWORD);
    expect([locked.status, await codeOf(locked)]).toEqual([401, "invalid_credentials"]);
    // A day passes: the bucket is full again and the right password signs in.
    await fx.admin((client) =>
      client.query(
        "UPDATE app.rate_buckets SET refilled_at = refilled_at - interval '24 hours' WHERE scope = 'login_account' AND key = $1",
        [bucketKey("login_account", email)],
      ),
    );
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  }, 120_000);

  it("a sign-in success refunds the account bucket in full", async () => {
    const email = "refund-1@example.test";
    await fx.signedIn(email);
    await signIn(email, "wrong-password-1");
    await signIn(email, "wrong-password-1");
    expect(await tokensOf("login_account", email)).toBeLessThan(99);
    expect((await signIn(email, PASSWORD)).status).toBe(200);
    expect(await tokensOf("login_account", email)).toBe(100);
  });
});

describe("the address bucket", () => {
  it("login_ip answers 429 with the bucket's Retry-After", async () => {
    const peer = "192.0.2.211";
    await empty("login_ip", ipSubject(peer));
    const answer = await signIn("nobody-ip-1@example.test", "wrong-password-1", peer);
    expect([answer.status, await codeOf(answer)]).toEqual([429, "too_many_requests"]);
    const wait = Number(answer.headers.get("retry-after"));
    // 60 tokens per 15 minutes: one token takes 15 seconds.
    expect(wait).toBeGreaterThanOrEqual(14);
    expect(wait).toBeLessThanOrEqual(15);
  });
});

describe("the resend bucket", () => {
  const sign = (email: string) =>
    ["/api/auth/sign-up/email", { name: "T", email, password: PASSWORD }] as const;
  const resend = (email: string) => ["/api/auth/send-verification-email", { email }] as const;
  it.each([
    ["sign-up", sign],
    ["send-verification-email", resend],
  ])("%s answers 429 once the address or the account has used its resends", async (_name, build) => {
    const emailA = `resend-${_name}-a@example.test`;
    const emailB = `resend-${_name}-b@example.test`;
    const peer = "192.0.2.212";
    await empty("verification_resend", ipSubject(peer));
    const [pathA, bodyA] = build(emailA);
    const byAddress = await fx.request(pathA, { body: bodyA, peer });
    expect([byAddress.status, await codeOf(byAddress)]).toEqual([429, "too_many_requests"]);
    await empty("verification_resend", emailB.toLowerCase());
    const [pathB, bodyB] = build(emailB);
    const byAccount = await fx.request(pathB, { body: bodyB });
    expect([byAccount.status, await codeOf(byAccount)]).toEqual([429, "too_many_requests"]);
  });
});

describe("the bucket limits themselves", () => {
  it("sign-up answers 429 after its bucket limit and the verify POST after its", async () => {
    const peer = "192.0.2.213";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const answer = await fx.request("/api/auth/sign-up/email", {
        body: { name: "T", email: `limit-${i}@example.test`, password: PASSWORD },
        peer,
      });
      statuses.push(answer.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const verifyPeer = "192.0.2.214";
    const verified: number[] = [];
    for (let i = 0; i < 21; i++) {
      const answer = await fx.request("/api/auth/verify-email", {
        body: { token: `bad-token-${i}` },
        peer: verifyPeer,
      });
      verified.push(answer.status);
    }
    expect(verified.slice(0, 20)).toEqual(Array(20).fill(400));
    expect(verified[20]).toBe(429);
  });
});
