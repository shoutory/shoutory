import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { expect, inject, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { testAuth } from "../support/auth.js";

const env = readTestEnv();
const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };
const ORIGIN = "https://app.example.test";
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

interface Fixture {
  readonly owner: ReturnType<TestDatabase["pool"]>;
  readonly worker: ReturnType<TestDatabase["pool"]>;
  readonly admin: Parameters<Parameters<typeof withAdminClient>[2]>[0];
}

async function answer(plant: (fixture: Fixture) => Promise<void>): Promise<[number, string | undefined]> {
  const db: TestDatabase = await cloneTemplate(env, inject("shoutoryTemplate"));
  const appPool = createAppPool(db.url("app"), () => undefined);
  try {
    await withAdminClient(env, db.name, (admin) =>
      plant({ owner: db.pool("owner"), worker: db.pool("worker"), admin }),
    );
    const lines: string[] = [];
    const logged = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
    const app = createApp({
      publicOrigin: ORIGIN,
      trustedProxies: [],
      pool: appPool,
      keys,
      logger: logged,
      auth: testAuth(appPool, keys, logged, ORIGIN),
    });
    const response = await Promise.resolve(app.request("/readyz", {}, REMOTE));
    return [response.status, /"cause":"([a-z_]+)"/.exec(lines.join("\n"))?.[1]];
  } finally {
    await appPool.end();
    await db.drop();
  }
}

const beat = (fixture: Fixture, id = "readiness-worker-1") =>
  fixture.worker.query("SELECT app.worker_heartbeat($1, 'worker')", [id]);
// The event is planted in the past, which just after 00:00 UTC is a day the template has no leaf for: the leaf of
// that day is created first, under the name ensure_partitions gives it.
const lateEvent = (seconds: number) => async (fixture: Fixture) => {
  const at = new Date(Date.now() - seconds * 1000);
  const from = at.toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await fixture.admin.query(
    `CREATE TABLE IF NOT EXISTS app.outbox_${from.replaceAll("-", "")} PARTITION OF app.outbox
     FOR VALUES FROM ('${from}') TO ('${to}')`,
  );
  await fixture.admin.query(
    "INSERT INTO app.outbox (id, created_at, type, payload) VALUES (uuidv7(), $1, 'test.event', '{}')",
    [at],
  );
};

// Never a fixed healthy answer. The limits: outbox lag 60 s, job lag 120 s, worker stale at 90 s.
it.each<[string, (fixture: Fixture) => Promise<void>, number, string | undefined]>([
  [
    "an undispatched event is older than 60 s",
    async (f) => {
      await beat(f);
      await lateEvent(90)(f);
    },
    503,
    "outbox_lag",
  ],
  ["no worker has ever beaten", async () => undefined, 503, "no_worker"],
  [
    "the only worker's last beat is older than 90 s",
    async (f) => {
      await beat(f);
      await f.admin.query("UPDATE app.worker_heartbeats SET seen_at = now() - interval '120 seconds'");
    },
    503,
    "no_worker",
  ],
  [
    "the queue library's schema is not installed",
    async (f) => {
      await beat(f);
      await f.owner.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    },
    503,
    "jobs_not_installed",
  ],
  [
    "a due job has waited longer than 120 s",
    async (f) => {
      await beat(f);
      await f.owner.query("SELECT pgboss.create_queue('lag-fixture', '{\"policy\":\"standard\"}')");
      await f.owner.query(
        "INSERT INTO pgboss.job (name, start_after) VALUES ('lag-fixture', now() - interval '300 seconds')",
      );
    },
    503,
    "job_lag",
  ],
  [
    "a fresh worker runs beside a dead one's stale row and an event 30 s old waits",
    async (f) => {
      await beat(f, "readiness-worker-dead");
      await f.admin.query("UPDATE app.worker_heartbeats SET seen_at = now() - interval '1 hour'");
      await beat(f, "readiness-worker-live");
      await lateEvent(30)(f);
    },
    200,
    undefined,
  ],
])("/readyz when %s", async (_fault, plant, status, cause) => {
  expect(await answer(plant)).toEqual([status, cause]);
});
