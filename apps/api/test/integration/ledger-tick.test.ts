import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import { createAppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { startFixtureSimulator } from "@shoutory/testkit/fixture-provider/simulator";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { assertJobsHealthy } from "../../src/health/jobs.js";
import { createBoss } from "../../src/jobs/boss.js";
import { admitAndWake, createLedgerTick } from "../../src/jobs/ledger/tick.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { startWorker } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { connectChannel, ledgerCredentials } from "../support/ledger-credentials.js";
import { connectThrough, seedDueTarget, seedWorkspace } from "../support/ledger-seed.js";

const env = readTestEnv();
const media = {
  storage: createFsDriver(join(tmpdir(), "shoutory-ledger-tick-unused")),
  scratchDir: join(tmpdir(), "shoutory-ledger-tick-scratch"),
};

let db: TestDatabase;
let ws: string;
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
const registry = createRegistry([fixtureManifest]);
const boss = () => createBoss(db.url("worker"), () => undefined);
const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);
const jobs = async () =>
  Number(
    (
      await admin(async (a) =>
        a.query("SELECT count(*) AS n FROM pgboss.job WHERE name = 'publish.fixture' AND state = 'created'"),
      )
    ).rows[0].n,
  );
let simulator: Awaited<ReturnType<typeof startFixtureSimulator>>;
beforeAll(async () => {
  simulator = await startFixtureSimulator();
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  ws = await admin((a) => seedWorkspace(a));
  connectThrough(db.pool("worker"));
});
afterAll(async () => {
  await simulator.close();
  await db.drop();
});

describe("admission and its wake-up", () => {
  it("a rolled-back admission leaves no job, a committed one leaves one per queue, and a second wake-up is not stored", async () => {
    await admin(async (a) => void (await a.query("DELETE FROM pgboss.job WHERE name = 'publish.fixture'")));
    const queue = boss();
    await queue.start();
    try {
      await admin((a) => seedDueTarget(a, ws));
      await admin((a) => seedDueTarget(a, ws));
      const rolledBack = withSystem(db.pool("worker"), "ledger", async (tx) => {
        await admitAndWake(tx, queue, registry);
        throw new Error("roll back");
      });
      await expect(rolledBack).rejects.toThrow("roll back");
      expect(await jobs()).toBe(0);
      const { admitted } = await withSystem(db.pool("worker"), "ledger", (tx) =>
        admitAndWake(tx, queue, registry),
      );
      expect(admitted.length).toBe(2);
      expect(await jobs()).toBe(1);
      await admin((a) => seedDueTarget(a, ws));
      await withSystem(db.pool("worker"), "ledger", (tx) => admitAndWake(tx, queue, registry));
      expect(await jobs()).toBe(1);
    } finally {
      await queue.stop({ graceful: true });
    }
  });

  it("names a refused target once with its reason and wakes no queue for it", async () => {
    await admin(async (a) => void (await a.query("DELETE FROM pgboss.job WHERE name = 'publish.fixture'")));
    const queue = boss();
    await queue.start();
    try {
      const variant = await admin((a) => seedDueTarget(a, ws));
      const tick = createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      });
      await tick.tick();
      await admin(async (a) => {
        await a.query("DELETE FROM pgboss.job WHERE name = 'publish.fixture'");
        await a.query("UPDATE app.post_variants SET schedule_state = 'scheduled' WHERE id = $1", [variant]);
      });
      lines.length = 0;
      await tick.tick();
      await tick.tick();
      const named = lines.filter((line) => line.includes(variant));
      expect(named.length).toBe(1);
      expect(named[0]).toContain("target_in_flight");
      expect(named[0]).not.toContain("operations_target_key");
      expect(await jobs()).toBe(0);
    } finally {
      await queue.stop({ graceful: true });
    }
  });
});

const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const credentials = () => ledgerCredentials(db.pool("worker"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const operationsOf = async (variant: string) =>
  Number(
    (await admin((a) => a.query("SELECT count(*) AS n FROM app.operations WHERE variant_id = $1", [variant])))
      .rows[0].n,
  );

describe("the worker's ledger tick", () => {
  it("starts and admits with an empty capability snapshot table, and close() stops the tick", async () => {
    const before = await admin((a) => seedDueTarget(a, ws));
    // Connecting a channel records a snapshot; this row is about a worker that admits with none.
    await admin((a) => a.query("DELETE FROM app.channel_capability_snapshots"));
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
      media,
      mail: {
        keys,
        pepper: new SealedSecret("ledger-tick-pepper-for-tests-0123456789"),
        smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
        from: "noreply@mail.example.test",
      },
      registry,
      ledgerIntervalMs: 50,
    });
    const snapshots = await admin((a) =>
      a.query("SELECT count(*)::int AS n FROM app.channel_capability_snapshots"),
    );
    expect(snapshots.rows[0].n).toBe(0);
    for (let tries = 0; tries < 100 && (await operationsOf(before)) === 0; tries++) await sleep(50);
    expect(await operationsOf(before)).toBe(1);
    await worker.close();
    const after = await admin((a) => seedDueTarget(a, ws));
    await sleep(400);
    expect(await operationsOf(after)).toBe(0);
  });
});

describe("the publish subscription", () => {
  it("dispatches an admitted target from the wake-up of its queue, for a provider that has an adapter", async () => {
    const wired = createRegistry([{ ...fixtureManifest, id: "subscribed" }]);
    const target = await admin((a) => seedDueTarget(a, ws, 30, "subscribed"));
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
      media,
      mail: {
        keys,
        pepper: new SealedSecret("ledger-tick-pepper-for-tests-0123456789"),
        smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
        from: "noreply@mail.example.test",
      },
      registry: wired,
      adapters: { subscribed: createFixtureAdapter({ baseUrl: simulator.url }) },
      fetchFor: () => fetch,
      ledgerIntervalMs: 50,
    });
    try {
      const state = async () =>
        (await admin((a) => a.query("SELECT state FROM app.operations WHERE variant_id = $1", [target])))
          .rows[0]?.state;
      for (let tries = 0; tries < 200 && (await state()) !== "published"; tries++) await sleep(50);
      expect(await state()).toBe("published");
    } finally {
      await worker.close();
    }
  }, 30_000);
});

describe("a post admitted ahead of its time", () => {
  it("sends a post admitted ahead of its due time when it falls due, with no other row admitted or moved", async () => {
    const wired = createRegistry([{ ...fixtureManifest, id: "aheadoftime" }]);
    const target = await admin((a) => seedDueTarget(a, ws, -4, "aheadoftime"));
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
      media,
      mail: {
        keys,
        pepper: new SealedSecret("ledger-tick-pepper-for-tests-0123456789"),
        smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
        from: "noreply@mail.example.test",
      },
      registry: wired,
      adapters: { aheadoftime: createFixtureAdapter({ baseUrl: simulator.url }) },
      fetchFor: () => fetch,
      ledgerIntervalMs: 300,
    });
    try {
      const read = async () =>
        (
          await admin((a) =>
            a.query(
              "SELECT state, clock_timestamp() < due_at AS early FROM app.operations WHERE variant_id = $1",
              [target],
            ),
          )
        ).rows[0] as { state: string; early: boolean } | undefined;
      const deadline = Date.now() + 15_000;
      const until = async (done: (found: Awaited<ReturnType<typeof read>>) => boolean) => {
        let found = await read();
        while (!done(found) && Date.now() < deadline) {
          await sleep(100);
          found = await read();
        }
        return found;
      };
      // Seen before it is due, it is pending and not sent; a slow start that first sees it after its time says nothing here.
      const first = await until((found) => found !== undefined);
      if (first?.early) expect(first.state).toBe("pending");
      expect((await until((found) => found?.state === "published"))?.state).toBe("published");
    } finally {
      await worker.close();
    }
  }, 30_000);
});

describe("a provider added without a migrate", () => {
  it("has its queues created when the worker starts, so admission can wake it", async () => {
    const added = createRegistry([{ ...fixtureManifest, id: "addedlate" }]);
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
      media,
      mail: {
        keys,
        pepper: new SealedSecret("ledger-tick-pepper-for-tests-0123456789"),
        smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
        from: "noreply@mail.example.test",
      },
      registry: added,
      ledgerIntervalMs: 60_000,
    });
    try {
      const queues = await admin((a) =>
        a.query("SELECT name, policy FROM pgboss.queue WHERE name LIKE '%.addedlate' ORDER BY name"),
      );
      expect(queues.rows).toEqual([
        { name: "publish.addedlate", policy: "short" },
        { name: "reconcile.addedlate", policy: "short" },
      ]);
    } finally {
      await worker.close();
    }
  });
});

describe("a lost wake-up", () => {
  it("loses nothing: the operation the tick admitted is claimed by a turn that no job woke", async () => {
    await admin(async (a) => {
      await a.query("DELETE FROM app.usage_reservations");
      await a.query("DELETE FROM app.operations");
      // No other target of this file is waiting to be admitted, so the turn can only meet the one below.
      await a.query(
        "UPDATE app.post_variants SET schedule_state = 'draft' WHERE schedule_state = 'scheduled'",
      );
    });
    const queue = boss();
    await queue.start();
    const variant = await admin((a) => seedDueTarget(a, ws));
    try {
      await createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      }).tick();
      await admin(async (a) => void (await a.query("DELETE FROM pgboss.job WHERE name = 'publish.fixture'")));
    } finally {
      await queue.stop({ graceful: true });
    }
    const turn = await runTurn({
      pool: db.pool("worker"),
      logger,
      registry,
      adapters: { fixture: createFixtureAdapter({ baseUrl: simulator.url }) },
      fetchFor: () => fetch,
      credentials: credentials(),
      queue: "publish.fixture",
      owner: "owner-w",
      closing: new AbortController().signal,
    });
    const made = await admin(async (a) =>
      a.query("SELECT id, state FROM app.operations WHERE variant_id = $1", [variant]),
    );
    expect(made.rows.length).toBe(1);
    expect(turn).toMatchObject({ kind: "dispatched", id: made.rows[0].id });
    expect(made.rows[0].state).toBe("published");
  });
});

describe("a backlog larger than one admission batch", () => {
  it("is admitted by one tick, batch after batch", async () => {
    const home = await admin((a) => seedWorkspace(a));
    await admin(async (a) => {
      for (let n = 0; n < 105; n++) await seedDueTarget(a, home);
    });
    const queue = boss();
    await queue.start();
    try {
      await createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      }).tick();
    } finally {
      await queue.stop({ graceful: true });
    }
    const made = await admin((a) =>
      a.query("SELECT count(*)::int AS n FROM app.operations WHERE workspace_id = $1", [home]),
    );
    expect(made.rows[0].n).toBe(105);
  }, 30_000);
});

describe("a post held while its channel is away", () => {
  it("is held by the tick when its channel needs a reconnect and resumes on the tick after the reconnect", async () => {
    const queue = boss();
    await queue.start();
    const variant = await admin((a) => seedDueTarget(a, ws));
    const channelTo = (state: string) =>
      admin((a) =>
        a.query(
          "UPDATE app.channels SET connection_state = $1 WHERE id = (SELECT channel_id FROM app.post_variants WHERE id = $2)",
          [state, variant],
        ),
      );
    const state = async () =>
      (
        await admin((a) => a.query("SELECT state FROM app.operations WHERE variant_id = $1", [variant]))
      ).rows.map((row) => row.state as string);
    try {
      const tick = createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      });
      await tick.tick();
      expect(await state()).toEqual(["pending"]);
      await channelTo("needs_reconnect");
      await tick.tick();
      expect(await state()).toEqual(["blocked_reconnect"]);
      await channelTo("connected");
      await tick.tick();
      expect(await state()).toEqual(["pending"]);
    } finally {
      await queue.stop({ graceful: true });
    }
  });
});

describe("the notices of the tick", () => {
  it("a token that expires in five days gets its card and mail on a tick, and not again on the next", async () => {
    const channel = await connectChannel(db.pool("worker"), {
      workspace: ws,
      provider: fixtureManifest.id,
      account: "tick-notice-account",
    });
    await admin((a) =>
      a.query(
        "UPDATE app.channel_credentials SET access_expires_at = now() + interval '5 days' WHERE channel_id = $1",
        [channel],
      ),
    );
    const queue = boss();
    await queue.start();
    try {
      const tick = createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      });
      await tick.tick();
      await tick.tick();
    } finally {
      await queue.stop({ graceful: true });
    }
    const cards = await admin((a) =>
      a.query("SELECT kind, level FROM app.notifications WHERE subject_id = $1", [channel]),
    );
    expect(cards.rows).toEqual([{ kind: "token_expiry", level: "7d" }]);
  });
});

describe("one failing step of the tick", () => {
  it("is logged and does not stop the sweep of due moves or the admission", async () => {
    const queue = boss();
    await queue.start();
    const variant = await admin((a) => seedDueTarget(a, ws));
    await admin(
      async (a) =>
        void (await a.query(
          "REVOKE EXECUTE ON FUNCTION app.sweep_expired_leases(jsonb) FROM shoutory_worker",
        )),
    );
    try {
      const tick = createLedgerTick({
        pool: db.pool("worker"),
        boss: queue,
        registry,
        logger,
        credentials: credentials(),
      });
      await expect(tick.tick()).resolves.toBeUndefined();
    } finally {
      await admin(
        async (a) =>
          void (await a.query(
            "GRANT EXECUTE ON FUNCTION app.sweep_expired_leases(jsonb) TO shoutory_worker",
          )),
      );
      await queue.stop({ graceful: true });
    }
    const failed = lines.find((line) => line.includes("ledger tick step failed")) ?? "";
    expect(failed).toContain("expired leases");
    expect(failed).toContain("42501");
    const made = await admin(async (a) =>
      a.query("SELECT count(*)::int AS n FROM app.operations WHERE variant_id = $1", [variant]),
    );
    expect(made.rows[0].n).toBe(1);
  });
});

describe("the outbox after a ledger move", () => {
  it("a worker run that moves one operation keeps /readyz ready after 60 s", async () => {
    // The tests before this one left over a hundred events no worker ever read. Only the events of this run's move are
    // waited for, so a slow host cannot fail the test by draining that backlog at the relay's rate.
    await admin((a) => a.query("UPDATE app.outbox SET dead_at = now() WHERE type LIKE 'operation.%'"));
    const target = await admin((a) => seedDueTarget(a, ws));
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
      media,
      mail: {
        keys,
        pepper: new SealedSecret("ledger-tick-pepper-for-tests-0123456789"),
        smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
        from: "noreply@mail.example.test",
      },
      registry,
      ledgerIntervalMs: 50,
    });
    try {
      for (let tries = 0; tries < 100 && (await operationsOf(target)) === 0; tries++) await sleep(50);
      // The worker closes only after the relay has ended every event of the moves: a closing relay leaves the rest claimed.
      const open = () =>
        admin(async (a) =>
          Number(
            (
              await a.query(
                "SELECT count(*) AS n FROM app.outbox o WHERE type LIKE 'operation.%' AND to_jsonb(o) ->> 'dead_at' IS NULL",
              )
            ).rows[0].n,
          ),
        );
      for (let tries = 0; tries < 100 && (await open()) > 0; tries++) await sleep(50);
      expect(await open()).toBe(0);
    } finally {
      await worker.close();
    }
    await admin((a) =>
      a.query(
        "UPDATE app.outbox SET created_at = created_at - interval '2 minutes' WHERE type LIKE 'operation.%'",
      ),
    );
    const appPool = createAppPool(db.url("app"), () => undefined);
    try {
      await expect(assertJobsHealthy(appPool)).resolves.toBeUndefined();
    } finally {
      await appPool.end();
    }
  }, 30_000);
});
