import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
beforeEach(() => rows("DELETE FROM app.outbox"));
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params?: unknown[]) => admin(async (a) => (await a.query(sql, params)).rows);
const worker = () => db.pool("worker");
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
// xid 1 lies below any visibility horizon, so a transaction another test file holds open cannot hold the rows back.
const plant = (n: number, type = "heartbeat.event") =>
  rows("INSERT INTO app.outbox (id, created_at, xid, type) VALUES ($1, now(), '1'::xid8, $2)", [id(n), type]);
const claim = async () => (await worker().query("SELECT * FROM app.outbox_claim(1)")).rows[0];
const beat = async (row: Record<string, unknown> | undefined, attempt: number) =>
  (
    await worker().query("SELECT app.outbox_heartbeat($1, $2, $3) AS kept", [
      row?.id,
      row?.created_at,
      attempt,
    ])
  ).rows[0]?.kept;
const lease = async () =>
  (await rows("SELECT claimed_until, attempts FROM app.outbox WHERE id = $1", [id(1)]))[0] as {
    claimed_until: Date | null;
    attempts: number;
  };
const nearLapse = () => rows("UPDATE app.outbox SET claimed_until = now() + interval '1 second'");

describe("outbox_heartbeat keeps only the live claim", () => {
  it("extends the live attempt's lease without a new attempt, and the stale mark still loses", async () => {
    await plant(1);
    const held = await claim();
    await nearLapse();
    expect(await beat(held, 1)).toBe(true);
    const after = await lease();
    expect(after.attempts).toBe(1);
    expect(after.claimed_until?.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(await claim()).toBeUndefined();
    const mark = (attempt: number) =>
      worker().query("SELECT app.outbox_mark($1, $2, $3) AS won", [held?.id, held?.created_at, attempt]);
    expect((await mark(0)).rows[0]).toEqual({ won: false });
    expect((await mark(1)).rows[0]).toEqual({ won: true });
  });

  it.each([
    ["a re-claimed row, from the attempt that lost it", "UPDATE app.outbox SET attempts = attempts + 1"],
    ["a lapsed lease nobody re-claimed", "UPDATE app.outbox SET claimed_until = now() - interval '1 second'"],
    ["a dispatched row", "UPDATE app.outbox SET dispatched_at = now(), claimed_until = NULL"],
  ])("refuses %s and leaves its lease as it was", async (_name, change) => {
    await plant(1);
    const held = await claim();
    await rows(change);
    const before = await lease();
    expect(await beat(held, 1)).toBe(false);
    expect(await lease()).toEqual(before);
  });
});

describe("outbox_claim's type filter", () => {
  const claimTypes = async (only: string[] | null, skip: string[] | null) =>
    (await worker().query("SELECT type FROM app.outbox_claim(10, $1, $2)", [only, skip])).rows
      .map((row) => row.type as string)
      .sort();

  it.each([
    ["an include list claims only its types", ["media.uploaded"], null, ["media.uploaded"]],
    ["an exclude list claims every other type", null, ["media.uploaded"], ["other.event"]],
    ["no list claims every type", null, null, ["media.uploaded", "other.event"]],
  ])("%s", async (_name, only, skip, claimed) => {
    await plant(1, "media.uploaded");
    await plant(2, "other.event");
    expect(await claimTypes(only, skip)).toEqual(claimed);
  });
});
