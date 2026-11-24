import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { startWorker } from "../../src/jobs/worker.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { png } from "../support/images.js";
import { seedWorkspace } from "../support/ledger-seed.js";

// `spawn` is wrapped, not replaced: the real image child runs, except in the row that makes it crash.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

// Each wait below is bounded by `settle`; the test limit only has to cover two of them and a real image run.
vi.setConfig({ testTimeout: 15_000 });
const env = readTestEnv();
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const pepper = new SealedSecret("media-gating-pepper-for-tests-0123456789");

let db: TestDatabase;
let dir: string;
let storage: ReturnType<typeof createFsDriver>;
let ws: string;
let stop: (() => Promise<void>) | undefined;
const admin = <T>(run: Parameters<typeof withAdminClient<T>>[2]) => withAdminClient(env, db.name, run);

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  dir = await mkdtemp(join(tmpdir(), "shoutory-gating-"));
  storage = createFsDriver(dir);
  ws = await admin((client) => seedWorkspace(client));
});
afterAll(async () => {
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  const worker = await startWorker({
    connectionString: db.url("worker"),
    pool: db.pool("worker"),
    logger,
    role: "worker",
    mail: {
      keys,
      pepper,
      smtpUrl: new SealedSecret("smtp://127.0.0.1:9"),
      from: "noreply@mail.example.test",
    },
    media: { storage },
    relayIntervalMs: 10,
  });
  stop = () => worker.close();
});
afterEach(async () => {
  await stop?.();
});

let planted = 0;
async function plant(state: string, claims: number): Promise<{ asset: string; event: string }> {
  const asset = randomUUID();
  // An image of its own size per asset: the pipeline proves the digest, and the live-hash index allows one asset of it.
  planted += 1;
  const bytes = await png(8 + planted);
  await admin((client) =>
    client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'gate.png', 'image/png',
         'upload', $3::uuid, $4, decode($5, 'hex'))`,
      [asset, ws, randomUUID(), state, createHash("sha256").update(bytes).digest("hex")],
    ),
  );
  await storage.put(`ws/${ws}/${asset}/1/original`, new Blob([new Uint8Array(bytes)]).stream(), 1024 * 1024);
  const event = (
    await admin((client) =>
      client.query(
        `INSERT INTO app.outbox (workspace_id, xid, type, payload, attempts)
         VALUES ($1, '1'::xid8, 'media.uploaded', jsonb_build_object('media_id', $2::text), $3) RETURNING id`,
        [ws, asset, claims],
      ),
    )
  ).rows[0].id as string;
  return { asset, event };
}
// The asset and its event in one statement, so one snapshot: the handler commits the asset's move before the relay marks
// the event, and reads taken one after the other could see the asset before the move and the event after the mark.
const look = async ({ asset, event }: { asset: string; event: string }) =>
  admin(
    async (client) =>
      (
        await client.query(
          `SELECT a.state, a.reject_reason, o.dispatched_at IS NOT NULL AS done, o.attempts AS claims
           FROM app.media_assets AS a, app.outbox AS o WHERE a.id = $1 AND o.id = $2`,
          [asset, event],
        )
      ).rows[0] as { state: string; reject_reason: string | null; done: boolean; claims: number },
  );
async function settle<T>(read: () => Promise<T>, wanted: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 4_000;
  for (;;) {
    const value = await read();
    if (wanted(value) || Date.now() > until) return value;
    await new Promise((wake) => setTimeout(wake, 25));
  }
}

describe("the relay runs the pipeline for a media.uploaded event", () => {
  it("a run that crashes leaves the asset processing, and the next claim finishes it", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
      real.spawn(process.execPath, ["-e", "process.exit(3)"], options as never),
    );
    const planted = await plant("uploaded", 0);
    const crashed = await settle(
      () => look(planted),
      (seen) => seen.state === "processing" && seen.claims === 1,
    );
    expect(crashed).toMatchObject({ state: "processing", done: false, claims: 1 });
    await admin((client) =>
      client.query("UPDATE app.outbox SET claimed_until = now() - interval '1 second' WHERE id = $1", [
        planted.event,
      ]),
    );
    const finished = await settle(
      () => look(planted),
      (seen) => seen.done,
    );
    expect(finished).toMatchObject({ state: "ready", done: true, claims: 2 });
  });

  it.each([
    ["uploaded", "rejected", "processing_failed"],
    ["processing", "rejected", "processing_failed"],
    // An asset that finished before its event was marked is left as it is, and the event still ends.
    ["ready", "ready", null],
  ])(
    "the 4th claim of an asset that is %s leaves it %s (%s) and ends the event",
    async (state, ends, why) => {
      const planted = await plant(state, 3);
      const seen = await settle(
        () => look(planted),
        (now) => now.done,
      );
      expect(seen).toMatchObject({ state: ends, reject_reason: why, done: true, claims: 4 });
    },
  );
});
