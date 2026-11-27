import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { withAdvisoryLock } from "@shoutory/db/locks";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PARTITION_CLASSES } from "../../src/jobs/registry.js";
import { ensurePartitions, purgeExpired, startWorker, sweepUploadParts } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/logging/logger.js";
import { enqueueMail } from "../../src/mail/enqueue.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { startSmtpSink } from "../support/smtp-sink.js";

const env = readTestEnv();
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
const adminOf =
  (database: () => TestDatabase) =>
  <T>(run: Parameters<typeof withAdminClient<T>>[2]) =>
    withAdminClient(env, database().name, run);
const admin = adminOf(() => db);
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const pepper = new SealedSecret("worker-jobs-pepper-for-tests-0123456789");
// Port 9 refuses connections: a test that does not read mail never reaches a server.
const options = (database: TestDatabase, smtpUrl = "smtp://127.0.0.1:9") => ({
  connectionString: database.url("worker"),
  pool: database.pool("worker"),
  logger,
  role: "worker" as const,
  media: {
    storage: createFsDriver(join(tmpdir(), "shoutory-worker-jobs-unused")),
    partsRoot: join(tmpdir(), "shoutory-worker-jobs-unused"),
    scratchDir: join(tmpdir(), "shoutory-worker-jobs-scratch"),
  },
  mail: { keys, pepper, smtpUrl: new SealedSecret(smtpUrl), from: "noreply@mail.example.test" },
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// True once no connection of the queue client is left in `database`; false after a second.
const queueClientGone = async (database: TestDatabase) => {
  for (let tries = 0; tries < 50; tries++) {
    const open = await adminOf(() => database)(
      async (a) =>
        (
          await a.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'shoutory-worker'",
            [database.name],
          )
        ).rows[0].n as number,
    );
    if (open === 0) return true;
    await sleep(20);
  }
  return false;
};

describe("the scheduled upkeep of the worker role", () => {
  it("registers the polls and sweeps once and purge_expired once per retention class", async () => {
    const worker = await startWorker(options(db));
    try {
      const { schedules, classes } = await admin(async (a) => ({
        schedules: (await a.query("SELECT name, key FROM pgboss.schedule ORDER BY name, key")).rows,
        classes: (await a.query("SELECT class, kind FROM app.retention_classes ORDER BY class")).rows,
      }));
      const wanted = classes.map(({ class: name }) => ({ name: "purge_expired", key: name }));
      expect(schedules).toEqual([
        { name: "connect_challenge_poll", key: "" },
        { name: "credential_refresh", key: "" },
        { name: "ensure_partitions", key: "" },
        { name: "media_gc", key: "" },
        ...wanted,
        { name: "sweep_upload_parts", key: "" },
      ]);
      const partitioned = classes.filter(({ kind }) => kind === "partition").map(({ class: name }) => name);
      expect([...PARTITION_CLASSES].sort()).toEqual(partitioned);
    } finally {
      await worker.close();
    }
  });

  it("purges a class in batches until none is left", async () => {
    await admin((a) =>
      a.query(
        `INSERT INTO app.rate_buckets (scope, key, tokens, refilled_at)
         SELECT 'invite', md5(n::text) || md5(n::text), 1, now() - interval '60 days' FROM generate_series(1, 5003) AS n`,
      ),
    );
    expect(await purgeExpired(db.pool("worker"), "app.rate_buckets", logger)).toBe(5003);
    expect((await admin((a) => a.query("SELECT count(*)::int AS n FROM app.rate_buckets"))).rows[0].n).toBe(
      0,
    );
  });

  it("names the leaf it keeps when an old outbox leaf still holds an undispatched event", async () => {
    const day = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const leaf = `outbox_${day.replaceAll("-", "")}`;
    await admin(async (a) => {
      await a.query(
        `CREATE TABLE app.${leaf} PARTITION OF app.outbox FOR VALUES FROM ('${day}') TO ('${next}')`,
      );
      await a.query(
        "INSERT INTO app.outbox (id, created_at, type, payload) VALUES (uuidv7(), $1, 'test.event', '{}')",
        [`${day}T12:00:00Z`],
      );
    });
    const before = lines.length;
    expect(await purgeExpired(db.pool("worker"), "outbox", logger)).toBe(0);
    expect(lines.slice(before).some((line) => line.includes(leaf) && line.includes('"level":"warn"'))).toBe(
      true,
    );
  });
});

describe("the part sweep is the filesystem's alone", () => {
  it("schedules no part sweep for a worker whose storage is not the filesystem", async () => {
    const fresh = await cloneTemplate(env, inject("shoutoryTemplate"));
    try {
      const worker = await startWorker({
        ...options(fresh),
        media: {
          storage: createFsDriver(join(tmpdir(), "shoutory-worker-jobs-unused")),
          scratchDir: join(tmpdir(), "shoutory-worker-jobs-scratch"),
        },
      });
      const names = await adminOf(() => fresh)(
        async (a) => (await a.query("SELECT DISTINCT name FROM pgboss.schedule ORDER BY name")).rows,
      );
      await worker.close();
      expect(names.map((row) => row.name)).not.toContain("sweep_upload_parts");
    } finally {
      await fresh.drop();
    }
  });
});

describe("the sweep of upload parts", () => {
  const NOW = new Date("2026-11-24T03:23:00Z");
  const eightDays = new Date(NOW.getTime() - 8 * 86_400_000);
  const planted = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "shoutory-sweep-job-"));
    const part = join(root, "ws/w1/m1/parts/1");
    await mkdir(dirname(part), { recursive: true });
    await writeFile(part, "stale-part-1");
    await utimes(part, eightDays, eightDays);
    return root;
  };

  it("removes a stale part and logs the count of files removed and of folders visited", async () => {
    const root = await planted();
    try {
      const before = lines.length;
      await sweepUploadParts(root, logger, { now: NOW });
      expect(
        lines.slice(before).some((line) => line.includes('"removed":1') && line.includes('"visited":')),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when the walk stopped at its deadline", async () => {
    const root = await planted();
    try {
      const before = lines.length;
      await sweepUploadParts(root, logger, { now: NOW, deadlineMs: 0 });
      expect(
        lines.slice(before).some((line) => line.includes('"level":"warn"') && line.includes('"removed":0')),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// One instance-wide key serializes every statement that takes ACCESS EXCLUSIVE on a partitioned parent. The
// choice is to wait: a second run queues behind the first instead of failing, so no daily run is lost.
describe("the maintenance lock", () => {
  const waitingOnLock = async () => {
    for (let tries = 0; tries < 100; tries++) {
      const rows = await db.pool("owner").query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 3 AND NOT granted
           AND database = (SELECT oid FROM pg_database WHERE datname = $1)`,
        [db.name],
      );
      if (rows.rows[0].n === 1) return true;
      await sleep(20);
    }
    return false;
  };
  const worker = () => db.pool("worker");

  it.each<[string, () => Promise<number>, boolean]>([
    ["the ensure_partitions run waits", () => ensurePartitions(worker()), true],
    ["the purge of a partition class waits", () => purgeExpired(worker(), "outbox", logger), true],
    [
      "the purge of a window class does not",
      () => purgeExpired(worker(), "app.worker_heartbeats", logger),
      false,
    ],
  ])("%s for another holder of the lock", async (_name, run, waits) => {
    const holder = await worker().connect();
    try {
      await holder.query("BEGIN");
      await withAdvisoryLock(holder, "maintenance", async () => undefined, "partitions");
      const started = run();
      if (!waits) expect(await started).toBeGreaterThanOrEqual(0);
      else expect(await waitingOnLock()).toBe(true);
      await holder.query("COMMIT");
      expect(await started).toBeGreaterThanOrEqual(0);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

describe("the worker's start and close", () => {
  it("close() stops the heartbeat, the relay and the queue client", async () => {
    const worker = await startWorker({ ...options(db), heartbeatMs: 10, relayIntervalMs: 10 });
    const planted = await admin(
      async (a) =>
        (
          await a.query(
            `INSERT INTO app.outbox (id, created_at, xid, type, payload)
             VALUES (uuidv7(), now(), '1'::xid8, 'test.unhandled', '{}') RETURNING id`,
          )
        ).rows[0].id as string,
    );
    await worker.close();
    const look = () =>
      admin(async (a) => ({
        seen: (await a.query("SELECT seen_at FROM app.worker_heartbeats")).rows,
        attempts: (await a.query("SELECT attempts FROM app.outbox WHERE id = $1", [planted])).rows,
      }));
    const atClose = await look();
    await sleep(150);
    expect(await look()).toEqual(atClose);
    expect(await queueClientGone(db)).toBe(true);
  });

  it("sends queued mail through the mail sender, and close() stops it", async () => {
    const sink = await startSmtpSink();
    const worker = await startWorker({ ...options(db, sink.url), mailIntervalMs: 10 });
    const queue = (n: number) =>
      enqueueMail(
        db.pool("app"),
        {
          workspaceId: null,
          recipient: `wired-${n}@example.test`,
          template: "verify_email",
          locale: "en",
          vars: {},
          link: `https://app.example.test/verify#token=wired-${n}`,
        },
        { keys, pepper },
      );
    try {
      await queue(1);
      for (let tries = 0; tries < 100 && sink.messages.length === 0; tries++) await sleep(25);
      expect(sink.messages).toHaveLength(1);
      await worker.close();
      await queue(2);
      await sleep(150);
      expect(sink.messages).toHaveLength(1);
    } finally {
      await sink.close();
    }
  });

  it("a failed start leaves no open queue connection", async () => {
    const bare = await cloneTemplate(env, inject("shoutoryTemplate"));
    try {
      await adminOf(() => bare)((a) => a.query("DROP SCHEMA pgboss CASCADE"));
      await expect(startWorker(options(bare))).rejects.toThrow();
      expect(await queueClientGone(bare)).toBe(true);
    } finally {
      await bare.drop();
    }
  });
});
