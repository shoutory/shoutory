import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withAdvisoryLock } from "../../src/locks.js";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// Class ids 1 and 2 are the migrate and channel classes; pg_locks shows each held advisory lock of this database.
const held = (db: TestDatabase, classId: number) =>
  db
    .pool("owner")
    .query(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1 AND database = (SELECT oid FROM pg_database WHERE datname = $2)`,
      [classId, db.name],
    )
    .then((result) => result.rows[0].n as number);

describe("withAdvisoryLock", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it("holds the migrate lock for the whole callback, outside any transaction, and releases it", async () => {
    const pool = db.pool("owner");
    const inside = await withAdvisoryLock(pool, "migrate", async (client) => {
      const status = await client.query("SELECT transaction_timestamp() = statement_timestamp() AS fresh");
      return { fresh: status.rows[0].fresh, held: await held(db, 1) };
    });
    expect(inside).toEqual({ fresh: true, held: 1 });
    expect(await held(db, 1)).toBe(0);
  });

  it("releases the migrate lock when the callback throws", async () => {
    await expect(
      withAdvisoryLock(db.pool("owner"), "migrate", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await held(db, 1)).toBe(0);
  });

  it("keeps the callback's error when the unlock fails as well", async () => {
    const run = withAdvisoryLock(db.pool("owner"), "migrate", async (client) => {
      // The killed connection reports its end as an error event as well; this test expects it.
      client.on("error", () => undefined);
      await client.query("SELECT pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
      throw new Error("callback failed");
    });
    await expect(run).rejects.toThrow("callback failed");
  });

  it("destroys the connection when the lock call itself fails", async () => {
    const holder = db.pool("owner");
    const waiter = new Pool({ connectionString: db.url("owner"), max: 1, options: "-c lock_timeout=200" });
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withAdvisoryLock(holder, "migrate", () => hold);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(withAdvisoryLock(waiter, "migrate", async () => undefined)).rejects.toThrow(
        "lock timeout",
      );
      expect(waiter.totalCount).toBe(0);
    } finally {
      release();
      await holding;
      await waiter.end();
    }
  });
});

describe("withAdvisoryLock channel class", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  // The probe must tell a two-key lock from a one-key lock with the same class and object numbers.
  it("refuses a channel lock when only a one-key session lock matches its ids", async () => {
    const client = await db.pool("owner").connect();
    const oneKey = "pg_" + "advisory_lock";
    try {
      await client.query(`SELECT ${oneKey}((2::bigint << 32) | (hashtext($1)::bigint & 4294967295))`, [
        "channel-3",
      ]);
      await expect(withAdvisoryLock(client, "channel", async () => undefined, "channel-3")).rejects.toThrow(
        "open transaction",
      );
    } finally {
      await client.query(`SELECT ${"pg_" + "advisory_unlock_all"}()`);
      client.release();
    }
  });

  it("refuses a channel lock taken outside a transaction", async () => {
    const client = await db.pool("owner").connect();
    try {
      await expect(withAdvisoryLock(client, "channel", async () => undefined, "channel-2")).rejects.toThrow(
        "open transaction",
      );
    } finally {
      client.release();
    }
  });

  it("holds a channel lock until its transaction ends", async () => {
    const client = await db.pool("owner").connect();
    try {
      await client.query("BEGIN");
      await withAdvisoryLock(client, "channel", async () => undefined, "channel-1");
      expect(await held(db, 2)).toBe(1);
      await client.query("COMMIT");
      expect(await held(db, 2)).toBe(0);
    } finally {
      client.release();
    }
  });
});
