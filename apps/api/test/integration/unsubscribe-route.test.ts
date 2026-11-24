import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

// RFC 8058 one-click: a mail client POSTs the URL of the List-Unsubscribe header with a form body and no cookie, no
// origin and no client header. The token in the path is the only credential.

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixture();
});
afterAll(() => fx.close());

const digestOf = (address: string) =>
  createHmac("sha256", Buffer.from(PEPPER))
    .update(`email_suppression:${address.toLowerCase()}`)
    .digest("hex");
const tokenFor = (address: string) => {
  const digest = digestOf(address);
  const mac = createHmac("sha256", Buffer.from(PEPPER)).update(`unsubscribe:${digest}`).digest();
  return `${Buffer.from(digest, "hex").toString("base64url")}.${mac.toString("base64url")}`;
};
let nextPeer = 1;
const oneClick = (token: string, peer = `198.51.100.${nextPeer++}`) =>
  Promise.resolve(
    fx.app.request(
      `/api/v1/unsubscribe/${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
      { incoming: { socket: { remoteAddress: peer } } },
    ),
  );
const suppressions = (address: string) =>
  fx.admin(
    async (admin) =>
      (
        await admin.query("SELECT reason FROM app.email_suppressions WHERE email_digest = $1", [
          digestOf(address),
        ])
      ).rows,
  );

describe("POST /api/v1/unsubscribe/{token}", () => {
  it("needs no login, writes one unsubscribe row and is idempotent", async () => {
    const address = "unsub-1@example.test";
    expect((await oneClick(tokenFor(address))).status).toBe(200);
    expect(await suppressions(address)).toEqual([{ reason: "unsubscribe" }]);
    expect((await oneClick(tokenFor(address))).status).toBe(200);
    expect(await suppressions(address)).toHaveLength(1);
  });

  it("matches the address case-insensitively", async () => {
    expect((await oneClick(tokenFor("Unsub-Case@Example.test"))).status).toBe(200);
    expect(await suppressions("unsub-case@example.test")).toHaveLength(1);
  });
});

describe("POST /api/v1/unsubscribe/{token} with a bad token", () => {
  it.each([
    [
      "a token with another HMAC",
      () => `${tokenFor("unsub-2@example.test").split(".")[0]}.${"A".repeat(43)}`,
    ],
    [
      "a token whose digest was altered",
      () => `${"B".repeat(43)}.${tokenFor("unsub-2@example.test").split(".")[1]}`,
    ],
    ["a token with no dot", () => tokenFor("unsub-2@example.test").replace(".", "")],
    ["a truncated token", () => tokenFor("unsub-2@example.test").slice(0, 40)],
    ["a token of garbage", () => "not-a-token"],
  ])("answers 404 for %s and writes nothing", async (_name, make) => {
    // The control: the route exists and accepts a good token, so the 404 below is the token's, not a missing route.
    expect((await oneClick(tokenFor("unsub-control@example.test"))).status).toBe(200);
    const total = () =>
      fx.admin(
        async (a) => (await a.query("SELECT count(*)::int AS n FROM app.email_suppressions")).rows[0].n,
      );
    const before = await total();
    expect((await oneClick(make())).status).toBe(404);
    expect(await total()).toBe(before);
  });
});

describe("POST /api/v1/unsubscribe/{token} limits and side effects", () => {
  // Mailbox providers post one-click requests from shared addresses (RFC 8058 3.2), so only a bad token costs a token.
  it("limits a client that posts bad tokens: the 21st answers 429 with Retry-After", async () => {
    const peer = "198.51.100.200";
    const answers = [];
    for (let i = 0; i < 21; i++) answers.push(await oneClick("not-a-token", peer));
    expect(answers.slice(0, 20).every((a) => a.status === 404)).toBe(true);
    expect(answers[20]?.status).toBe(429);
    expect(Number(answers[20]?.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("does not limit valid tokens: 25 posts from one address all answer 200", async () => {
    const peer = "198.51.100.201";
    for (let i = 0; i < 25; i++) {
      expect((await oneClick(tokenFor(`unsub-3-${i}@example.test`), peer)).status).toBe(200);
    }
  });

  it("keeps the token out of every log line", async () => {
    const token = tokenFor("unsub-5@example.test");
    expect((await oneClick(token)).status).toBe(200);
    expect(fx.logged.length).toBeGreaterThan(0);
    for (const part of token.split(".")) expect(fx.logged.join("\n")).not.toContain(part);
  });
});
