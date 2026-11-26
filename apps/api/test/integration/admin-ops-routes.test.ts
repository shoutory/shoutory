import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signedUser } from "../support/tenancy.js";
import { cookieOf, type Fixture, PASSWORD, startFixture } from "./auth/harness.js";

const QUEUE = "/api/v1/admin/queue";
const SYSTEM = "/api/v1/admin/system";
const DNS = "/api/v1/admin/mail/check";
const TEST_MAIL = "/api/v1/admin/mail/test";

let fx: Fixture;
let adminId: string;
let adminEmail: string;
let outsider: { id: string; cookie: string };
beforeAll(async () => {
  fx = await startFixture();
  const first = await signedUser(fx, "ops-first");
  adminId = first.id;
  adminEmail = (
    await fx.admin((client) => client.query('SELECT email FROM auth."user" WHERE id = $1', [first.id]))
  ).rows[0].email;
  outsider = await signedUser(fx, "ops-outsider");
});
afterAll(async () => {
  await fx.close();
});

const login = async (): Promise<string> =>
  cookieOf(await fx.request("/api/auth/sign-in/email", { body: { email: adminEmail, password: PASSWORD } }));
const send = (method: "GET" | "POST", path: string, cookie: string) =>
  fx.request(path, { method, headers: { cookie } });
const errorCode = async (answer: Response) =>
  ((await answer.json()) as { error?: { code: string } }).error?.code;
const queued = (address: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          "SELECT template FROM app.email_outbox WHERE recipient = $1 AND template = 'mail_test'",
          [address],
        )
      ).rows.length,
  );
const staleStepUp = (userId: string) =>
  fx.admin((client) =>
    client.query("UPDATE app.session_step_ups SET at = at - interval '11 minutes' WHERE user_id = $1", [
      userId,
    ]),
  );

describe("the admin routes of the ops screens: who may reach them", () => {
  it.each([
    ["GET", QUEUE],
    ["GET", SYSTEM],
    ["POST", DNS],
    ["POST", TEST_MAIL],
  ] as const)(
    "%s %s answers 401 with no session and 404 to a user who is not an instance admin",
    async (method, path) => {
      expect((await send(method, path, "")).status).toBe(401);
      const answer = await send(method, path, outsider.cookie);
      expect([answer.status, await errorCode(answer)]).toEqual([404, "not_found"]);
    },
  );
});

describe("GET /api/v1/admin/queue", () => {
  it("answers the worker rows with their stale flag, the outbox lag and the job queue to an admin", async () => {
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.worker_heartbeats (worker_id, role, started_at, seen_at) VALUES
           ('ops-fresh', 'worker', now(), now()), ('ops-silent', 'all', now() - interval '2 hours', now() - interval '1 hour')`,
      ),
    );
    const answer = await send("GET", QUEUE, await login());
    expect(answer.status).toBe(200);
    const { data } = (await answer.json()) as {
      data: {
        workers: Array<{ worker_id: string; stale: boolean }>;
        outbox_lag_seconds: number;
        jobs: { installed: boolean };
      };
    };
    const stale = Object.fromEntries(data.workers.map((worker) => [worker.worker_id, worker.stale]));
    expect([stale["ops-fresh"], stale["ops-silent"]]).toEqual([false, true]);
    expect(typeof data.outbox_lag_seconds).toBe("number");
    expect(typeof data.jobs.installed).toBe("boolean");
  });
});

describe("GET /api/v1/admin/system", () => {
  it("answers the version, the channel (stable by default) and the migration status to an admin", async () => {
    const root = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));
    const answer = await send("GET", SYSTEM, await login());
    expect(answer.status).toBe(200);
    const { data } = (await answer.json()) as {
      data: {
        version: string | null;
        channel: string;
        migrations: { applied: number; shipped: number; pending: string[] };
      };
    };
    expect([data.version, data.channel]).toEqual([root.version, "stable"]);
    expect(data.migrations.pending).toEqual([]);
    expect(data.migrations.shipped).toBeGreaterThan(0);
    expect(data.migrations.applied).toBe(data.migrations.shipped);
  });
});

describe("POST /api/v1/admin/mail/check", () => {
  it("is read-only: an admin needs no recent step-up", async () => {
    const cookie = await login();
    await staleStepUp(adminId);
    expect((await send("POST", DNS, cookie)).status).toBe(200);
  });
});

describe("POST /api/v1/admin/mail/test", () => {
  it("answers 404 to a non-admin whose step-up is stale, queueing nothing", async () => {
    await staleStepUp(outsider.id);
    const answer = await send("POST", TEST_MAIL, outsider.cookie);
    expect([answer.status, await errorCode(answer)]).toEqual([404, "not_found"]);
    expect(await queued(adminEmail)).toBe(0);
  });

  it("answers 403 step_up_required to an admin without a recent step-up, queueing nothing", async () => {
    const cookie = await login();
    await staleStepUp(adminId);
    const answer = await send("POST", TEST_MAIL, cookie);
    expect([answer.status, await errorCode(answer)]).toEqual([403, "step_up_required"]);
    expect(await queued(adminEmail)).toBe(0);
  });

  it("queues exactly one mail_test message, in the caller's language, to the caller's own address and to nobody else", async () => {
    const answer = await fx.request(TEST_MAIL, {
      method: "POST",
      headers: { cookie: await login(), "accept-language": "ar" },
    });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { data: unknown }).data).toEqual({ queued: true });
    const tests = (await fx.mails(adminEmail)).filter((mail) => mail.template === "mail_test");
    expect(tests.map((mail) => mail.locale)).toEqual(["ar"]);
    const others = await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT count(*) AS n FROM app.email_outbox WHERE template = 'mail_test' AND recipient <> $1",
            [adminEmail],
          )
        ).rows[0].n,
    );
    expect(Number(others)).toBe(0);
  });

  // The bucket is the verification-resend one, keyed by the caller's own address: five an hour, then 429.
  it("answers exactly five test messages in the hour, then 429, and queues exactly five", async () => {
    const cookie = await login();
    // A fresh bucket: the earlier rows of this file spent tokens of the same address.
    await fx.admin((client) =>
      client.query("DELETE FROM app.rate_buckets WHERE scope = 'verification_resend'"),
    );
    const before = await queued(adminEmail);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1)
      statuses.push((await send("POST", TEST_MAIL, cookie)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await queued(adminEmail)) - before).toBe(5);
  });
});
