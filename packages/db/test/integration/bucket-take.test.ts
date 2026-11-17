import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// The throttle is one definer: capacity and refill are constants per scope inside it (R57), the key is always an
// HMAC digest, and the bucket row is keyed by scope and key together (R87). Time moves by editing `refilled_at`
// as the superuser: nothing sleeps.
let counter = 1;
/** A fresh 64-hex digest per call, so no two rows share a bucket. */
const fresh = (): string => (counter++).toString(16).padStart(64, "0");

interface Answer {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

interface Buckets {
  take: (key: string, scope: string, cost?: number) => Promise<Answer>;
  state: (key: string, scope: string) => Promise<Answer>;
  rows: (key: string) => Promise<number>;
  ago: (key: string, scope: string, seconds: number) => Promise<unknown>;
  client: () => Promise<PoolClient>;
}

function useBuckets(): Buckets {
  let db: TestDatabase;
  let auth: Pool;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    auth = db.pool("auth");
  });
  afterAll(() => db.drop());
  return {
    client: () => auth.connect(),
    take: async (key, scope, cost = 1) =>
      (await auth.query("SELECT * FROM app.bucket_take($1, $2, $3)", [key, scope, cost])).rows[0],
    state: async (key, scope) =>
      (await auth.query("SELECT * FROM app.bucket_state($1, $2)", [key, scope])).rows[0],
    // The table is the definers' alone, so the count is read as the superuser.
    rows: (key) =>
      withAdminClient(
        env,
        db.name,
        async (admin) =>
          (await admin.query("SELECT count(*)::int AS n FROM app.rate_buckets WHERE key = $1", [key])).rows[0]
            .n,
      ),
    ago: (key, scope, seconds) =>
      withAdminClient(env, db.name, (admin) =>
        admin.query(
          "UPDATE app.rate_buckets SET refilled_at = refilled_at - make_interval(secs => $3) WHERE key = $1 AND scope = $2",
          [key, scope, seconds],
        ),
      ),
  };
}

describe("bucket_take: spending, refilling and refunding", () => {
  const b = useBuckets();

  it.each([
    ["login_account", 100],
    ["login_ip", 60],
    ["verification_resend", 5],
    ["two_factor", 10],
    ["password_reset", 5],
    ["totp_code", 1],
    ["link_confirm", 20],
  ])("%s starts with its capacity of %i and spends one token per take", async (scope, capacity) => {
    expect(await b.take(fresh(), scope)).toEqual({
      allowed: true,
      remaining: capacity - 1,
      retry_after_seconds: 0,
    });
  });
});

describe("bucket_take: the refill clock", () => {
  const b = useBuckets();

  it("refuses at empty with the retry delay and refills with time", async () => {
    const key = fresh();
    expect((await b.take(key, "totp_code")).allowed).toBe(true);
    const refused = await b.take(key, "totp_code");
    expect(refused).toMatchObject({ allowed: false, remaining: 0 });
    expect(refused.retry_after_seconds).toBeGreaterThanOrEqual(89);
    expect(refused.retry_after_seconds).toBeLessThanOrEqual(90);
    await b.ago(key, "totp_code", 45);
    expect((await b.take(key, "totp_code")).allowed).toBe(false);
    await b.ago(key, "totp_code", 45);
    expect((await b.take(key, "totp_code")).allowed).toBe(true);
  });

  it.each(["take", "state"] as const)(
    "%s: a refilled_at in the future never lengthens the wait past the scope's span",
    async (call) => {
      const key = fresh();
      await b.take(key, "totp_code");
      await b.ago(key, "totp_code", -3600);
      const answer = await b[call](key, "totp_code");
      expect(answer.allowed).toBe(false);
      expect(answer.retry_after_seconds).toBeLessThanOrEqual(90);
    },
  );
});

describe("bucket_take: refunds and scopes", () => {
  const b = useBuckets();

  it("a refund restores tokens up to the capacity and no further", async () => {
    const key = fresh();
    for (let spent = 0; spent < 3; spent++) await b.take(key, "link_confirm");
    expect(await b.take(key, "link_confirm", -2)).toMatchObject({ allowed: true, remaining: 19 });
    expect(await b.take(key, "link_confirm", -20)).toMatchObject({ allowed: true, remaining: 20 });
  });

  it("a refund on a key with no bucket writes nothing and answers a full bucket", async () => {
    const key = fresh();
    expect(await b.take(key, "login_account", -1)).toEqual({
      allowed: true,
      remaining: 100,
      retry_after_seconds: 0,
    });
    expect(await b.rows(key)).toBe(0);
  });

  it("one key under two scopes is two buckets", async () => {
    const key = fresh();
    expect(await b.take(key, "login_ip")).toMatchObject({ remaining: 59 });
    expect(await b.take(key, "link_confirm")).toMatchObject({ remaining: 19 });
    expect(await b.take(key, "link_confirm")).toMatchObject({ remaining: 18 });
    expect(await b.take(key, "login_ip")).toMatchObject({ remaining: 58 });
    expect(await b.rows(key)).toBe(2);
  });
});

// Two connections race for the last token of a bucket that is already refilled: exactly one is allowed. The first
// holds its update uncommitted, so the second must wait for the row lock and then see the spent token.
describe("bucket_take race", () => {
  const b = useBuckets();

  it("two concurrent calls on a bucket of one token allow exactly one", async () => {
    const key = fresh();
    await b.take(key, "totp_code");
    await b.ago(key, "totp_code", 90);
    const one = await b.client();
    const two = await b.client();
    let clean = false;
    try {
      await one.query("BEGIN");
      const first = (await one.query("SELECT * FROM app.bucket_take($1, 'totp_code', 1)", [key])).rows[0];
      const pending = two.query("SELECT * FROM app.bucket_take($1, 'totp_code', 1)", [key]);
      pending.catch(() => undefined);
      await delay(300);
      await one.query("COMMIT");
      expect([first.allowed, (await pending).rows[0].allowed]).toEqual([true, false]);
      clean = true;
    } finally {
      one.release(!clean);
      two.release(!clean);
    }
  });
});

describe("bucket_take refusals and bucket_state", () => {
  const b = useBuckets();

  it.each([
    ["an unknown scope", fresh(), "nope", 1],
    ["a scope that has no numbers yet", fresh(), "invite", 1],
    ["a raw email instead of a digest", "someone@example.test", "login_account", 1],
    ["an upper-case digest", `A${"0".repeat(63)}`, "login_account", 1],
    ["a digest one character short", "0".repeat(63), "login_account", 1],
    ["a cost of zero", fresh(), "link_confirm", 0],
    ["a cost above one", fresh(), "link_confirm", 2],
    ["a refund beyond the capacity", fresh(), "link_confirm", -21],
  ])("refuses %s", async (_title, key, scope, cost) => {
    await expect(b.take(key, scope, cost)).rejects.toMatchObject({ code: "22023" });
    expect(await b.rows(key)).toBe(0);
  });

  it.each([
    ["an unknown scope", fresh(), "nope"],
    ["a scope that has no numbers yet", fresh(), "invite"],
    ["a raw email instead of a digest", "someone@example.test", "login_account"],
    ["a digest one character short", "0".repeat(63), "login_account"],
  ])("bucket_state refuses %s", async (_title, key, scope) => {
    await expect(b.state(key, scope)).rejects.toMatchObject({ code: "22023" });
    expect(await b.rows(key)).toBe(0);
  });

  it("bucket_state reads without spending and writes no row for an unseen key", async () => {
    const key = fresh();
    expect(await b.state(key, "two_factor")).toEqual({
      allowed: true,
      remaining: 10,
      retry_after_seconds: 0,
    });
    expect(await b.rows(key)).toBe(0);
    await b.take(key, "two_factor");
    expect(await b.state(key, "two_factor")).toMatchObject({ allowed: true, remaining: 9 });
    expect(await b.state(key, "two_factor")).toMatchObject({ allowed: true, remaining: 9 });
    await b.take(key, "totp_code");
    expect(await b.state(key, "totp_code")).toMatchObject({ allowed: false, remaining: 0 });
  });
});
