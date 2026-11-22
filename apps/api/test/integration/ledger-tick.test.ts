import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createBoss } from "../../src/jobs/boss.js";
import { admitAndWake, createLedgerTick } from "../../src/jobs/ledger/tick.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { startWorker } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/logging/logger.js";
import { seedDueTarget, seedWorkspace } from "../support/ledger-seed.js";

const env = readTestEnv();

// The tick of the ledger: admission sends its wake-up in its own transaction, at most one wake-up waits for a queue, and
// a step of the tick that fails does not stop the others. Each row says what it fails against once the module exists;
// today every row fails first because the module does not exist.
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
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  ws = await admin((a) => seedWorkspace(a));
});
afterAll(() => db.drop());

describe("admission and its wake-up", () => {
  it("a rolled-back admission leaves no job, a committed one leaves one per queue, and a second wake-up is not stored", async () => {
    // fails first because: the wake-up goes out after the commit or outside the transaction, or two targets store two jobs
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
      const admitted = await withSystem(db.pool("worker"), "ledger", (tx) =>
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
});

const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const operationsOf = async (variant: string) =>
  Number(
    (await admin((a) => a.query("SELECT count(*) AS n FROM app.operations WHERE variant_id = $1", [variant])))
      .rows[0].n,
  );

describe("the worker's ledger tick", () => {
  it("starts and admits with an empty capability snapshot table, and close() stops the tick", async () => {
    // fails first because: the worker has no tick, or a start gate waits for a capability snapshot that no channel has yet
    const before = await admin((a) => seedDueTarget(a, ws));
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
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

describe("a provider added without a migrate", () => {
  it("has its queues created when the worker starts, so admission can wake it", async () => {
    // fails first because: the queues exist only after `shoutory migrate`, and a wake-up for a missing queue stalls admission
    const added = createRegistry([{ ...fixtureManifest, id: "addedlate" }]);
    const worker = await startWorker({
      connectionString: db.url("worker"),
      pool: db.pool("worker"),
      logger,
      role: "worker",
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
    // fails first because: a turn waits for its job, or the claim cannot see an operation whose wake-up is gone
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
      await createLedgerTick({ pool: db.pool("worker"), boss: queue, registry, logger }).tick();
      await admin(async (a) => void (await a.query("DELETE FROM pgboss.job WHERE name = 'publish.fixture'")));
    } finally {
      await queue.stop({ graceful: true });
    }
    const turn = await runTurn({
      pool: db.pool("worker"),
      logger,
      registry,
      queue: "publish.fixture",
      owner: "owner-w",
      closing: new AbortController().signal,
    });
    const made = await admin(async (a) =>
      a.query("SELECT id, state FROM app.operations WHERE variant_id = $1", [variant]),
    );
    expect(made.rows.length).toBe(1);
    expect(turn).toMatchObject({ kind: "ready", id: made.rows[0].id });
    expect(made.rows[0].state).toBe("claimed");
  });
});

describe("a backlog larger than one admission batch", () => {
  it("is admitted by one tick, batch after batch", async () => {
    // fails first because: one tick admits one batch, so a backlog of more than 100 waits for the next tick
    const home = await admin((a) => seedWorkspace(a));
    await admin(async (a) => {
      for (let n = 0; n < 105; n++) await seedDueTarget(a, home);
    });
    const queue = boss();
    await queue.start();
    try {
      await createLedgerTick({ pool: db.pool("worker"), boss: queue, registry, logger }).tick();
    } finally {
      await queue.stop({ graceful: true });
    }
    const made = await admin((a) =>
      a.query("SELECT count(*)::int AS n FROM app.operations WHERE workspace_id = $1", [home]),
    );
    expect(made.rows[0].n).toBe(105);
  }, 30_000);
});

describe("one failing step of the tick", () => {
  it("is logged and does not stop the sweep of due moves or the admission", async () => {
    // fails first because: the first failing step throws out of the tick and the steps after it never run
    const queue = boss();
    await queue.start();
    const variant = await admin((a) => seedDueTarget(a, ws));
    await admin(
      async (a) =>
        void (await a.query("REVOKE EXECUTE ON FUNCTION app.sweep_expired_leases() FROM shoutory_worker")),
    );
    try {
      const tick = createLedgerTick({ pool: db.pool("worker"), boss: queue, registry, logger });
      await expect(tick.tick()).resolves.toBeUndefined();
    } finally {
      await admin(
        async (a) =>
          void (await a.query("GRANT EXECUTE ON FUNCTION app.sweep_expired_leases() TO shoutory_worker")),
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
