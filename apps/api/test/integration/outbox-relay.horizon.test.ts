import { randomUUID } from "node:crypto";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createOutboxRelay,
  type OutboxHandlers,
  type OutboxRelayOptions,
} from "../../src/jobs/outbox-relay.js";
import { createLogger } from "../../src/logging/logger.js";

const env = readTestEnv();
const CANARY = "relay-canary-payload-1";

let db: TestDatabase;
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);
const plant = (type: string, payload: object = {}) =>
  admin(
    async (a) =>
      (
        await a.query(
          // xid 1 lies below any visibility horizon, so a transaction another test file holds open cannot hold the
          // rows back (the horizon itself is tested with the claim definer).
          "INSERT INTO app.outbox (id, created_at, xid, type, payload) VALUES ($1, now(), '1'::xid8, $2, $3) RETURNING id",
          [randomUUID(), type, JSON.stringify(payload)],
        )
      ).rows[0].id as string,
  );
const row = (id: string) =>
  admin(
    async (a) =>
      (await a.query("SELECT dispatched_at, claimed_until, attempts FROM app.outbox WHERE id = $1", [id]))
        .rows[0] as { dispatched_at: Date | null; claimed_until: Date | null; attempts: number },
  );
const relay = (handlers: OutboxHandlers, batch = 5, extra: Partial<OutboxRelayOptions> = {}) =>
  createOutboxRelay({ pool: db.pool("worker"), handlers, logger, batch, ...extra });
type Handler = OutboxHandlers[string];
interface Probe {
  aborted: boolean;
}

describe("the outbox relay (at least once)", () => {
  it("two relays drain the outbox and each row is delivered once", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => plant("test.event")));
    const delivered = new Map<string, number>();
    const handlers: OutboxHandlers = {
      "test.event": async (event) => void delivered.set(event.id, (delivered.get(event.id) ?? 0) + 1),
    };
    const [a, b] = [relay(handlers), relay(handlers)];
    for (let round = 0; round < 10; round++) await Promise.all([a.tick(), b.tick()]);
    expect([...delivered.keys()].sort()).toEqual([...ids].sort());
    expect([...delivered.values()].every((count) => count === 1)).toBe(true);
    expect((await row(ids[0] as string)).dispatched_at).not.toBeNull();
  });

  it("leaves an event with no handler unmarked and logs its type but never its payload", async () => {
    const id = await plant("test.unhandled", { secret: CANARY });
    expect(await relay({}).tick()).toBe(0);
    const after = await row(id);
    expect(after.dispatched_at).toBeNull();
    expect(after.claimed_until).not.toBeNull();
    expect(lines.some((line) => line.includes("test.unhandled"))).toBe(true);
    expect(lines.some((line) => line.includes(CANARY))).toBe(false);
  });
});

describe("the outbox relay's failures", () => {
  // Neither ends the row: its lease lapses and the lag shows it. A log line carries the type, never the payload, even
  // when the handler put the payload into its error message.
  it.each<[string, (probe: Probe) => Handler, boolean]>([
    [
      "throws, with the payload in its message",
      () => async () => {
        throw new Error(`failed for ${CANARY}`);
      },
      false,
    ],
    [
      "outlives its timeout and sees its signal abort",
      (probe) => (_event, signal) =>
        new Promise<void>((resolve) => {
          if (!signal) return resolve();
          signal.addEventListener("abort", () => {
            probe.aborted = true;
            resolve();
          });
        }),
      true,
    ],
  ])("leaves the row unmarked when its handler %s", async (_name, make, aborted) => {
    const id = await plant("test.fail", { secret: CANARY });
    const probe: Probe = { aborted: false };
    const before = lines.length;
    expect(await relay({ "test.fail": make(probe) }, 5, { handlerTimeoutMs: 50 }).tick()).toBe(0);
    const after = await row(id);
    expect(after.dispatched_at).toBeNull();
    expect(after.claimed_until).not.toBeNull();
    expect(probe.aborted).toBe(aborted);
    const logged = lines.slice(before);
    expect(logged.some((line) => line.includes("test.fail"))).toBe(true);
    expect(logged.some((line) => line.includes(CANARY))).toBe(false);
  });
});

describe("the outbox relay's loop", () => {
  it("stops within its bound while a handler never finishes", async () => {
    await plant("test.hang");
    let claimed = (): void => undefined;
    const taken = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const loop = relay(
      {
        "test.hang": () => {
          claimed();
          return new Promise<void>(() => undefined);
        },
      },
      5,
      { intervalMs: 5, stopTimeoutMs: 50 },
    );
    loop.start();
    await taken;
    const outcome = await Promise.race([
      loop.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("starts once: a second start, or a start after stop, throws", async () => {
    const loop = relay({}, 5, { intervalMs: 60_000 });
    loop.start();
    try {
      expect(() => loop.start()).toThrow();
      await loop.stop();
      expect(() => loop.start()).toThrow();
    } finally {
      await loop.stop();
    }
  });
});

// A handler that announces it runs and then waits for its signal, recording why it aborted.
function waitsForAbort() {
  let announce = (): void => undefined;
  const running = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const seen: { reason?: string } = {};
  const handler: Handler = (_event, signal) => {
    announce();
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        seen.reason = (signal.reason as Error).name;
        resolve();
      });
    });
  };
  return { running, handler, seen };
}
const setLease = (id: string, sql: string) =>
  admin((c) => c.query(`UPDATE app.outbox SET ${sql} WHERE id = $1`, [id]));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the outbox relay's heartbeat", () => {
  it("keeps a long handler's claim past the lease, so another relay claims nothing", async () => {
    const id = await plant("test.long");
    const long = waitsForAbort();
    const loop = relay({ "test.long": long.handler }, 1, {
      types: ["test.long"],
      heartbeatMs: 20,
      intervalMs: 5,
    });
    loop.start();
    await long.running;
    await setLease(id, "claimed_until = now() + interval '1 second'");
    await sleep(1200);
    expect((await row(id)).claimed_until?.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await relay({ "test.long": long.handler }, 1, { types: ["test.long"] }).tick()).toBe(0);
    await loop.stop();
    expect(long.seen.reason).toBe("RelayStopping");
    const after = (await row(id)).claimed_until;
    await sleep(100);
    expect((await row(id)).claimed_until).toEqual(after);
  });

  it("aborts the handler when a beat finds the claim lost, and leaves the row unmarked", async () => {
    const id = await plant("test.lost");
    const lost = waitsForAbort();
    const run = relay({ "test.lost": lost.handler }, 1, { types: ["test.lost"], heartbeatMs: 20 }).tick();
    await lost.running;
    await setLease(id, "attempts = attempts + 1");
    expect(await run).toBe(0);
    expect(lost.seen.reason).toBe("ClaimLost");
    expect((await row(id)).dispatched_at).toBeNull();
  });
});

describe("the outbox relay's types", () => {
  it.each([
    ["an include list delivers only its types", { types: ["test.kept"] }, ["test.kept"]],
    ["an exclude list never delivers its types", { excludeTypes: ["test.left"] }, ["test.kept"]],
  ])("%s", async (_name, filter, delivered) => {
    await admin((a) => a.query("DELETE FROM app.outbox"));
    await plant("test.kept");
    await plant("test.left");
    const seen: string[] = [];
    const record: Handler = async (event) => void seen.push(event.type);
    await relay({ "test.kept": record, "test.left": record }, 5, filter).tick();
    expect(seen).toEqual(delivered);
  });
});

describe("the outbox relay's claim", () => {
  it("fences a claimer whose lease lapsed: its mark cannot end the row the new claimer holds", async () => {
    const id = await plant("test.slow");
    // Each handler announces that its claim was taken and then waits for a promise this test resolves: no timer.
    const held = () => {
      let release = (): void => undefined;
      let announce = (): void => undefined;
      const claimed = new Promise<"claimed">((resolve) => {
        announce = () => resolve("claimed");
      });
      const handler = () => {
        announce();
        return new Promise<void>((open) => {
          release = open;
        });
      };
      return { claimed, handler, release: () => release() };
    };
    const [a, b] = [held(), held()];
    const firstRun = relay({ "test.slow": a.handler }).tick();
    expect(await Promise.race([a.claimed, firstRun.then(() => "returned")])).toBe("claimed");
    // The first claimer's lease lapses (the superuser bypasses the table's row security).
    await admin((c) =>
      c.query("UPDATE app.outbox SET claimed_until = now() - interval '1 second' WHERE id = $1", [id]),
    );
    const secondRun = relay({ "test.slow": b.handler }).tick();
    expect(await Promise.race([b.claimed, secondRun.then(() => "returned")])).toBe("claimed");
    a.release();
    await firstRun;
    expect((await row(id)).dispatched_at).toBeNull();
    b.release();
    await secondRun;
    expect((await row(id)).dispatched_at).not.toBeNull();
  });
});
