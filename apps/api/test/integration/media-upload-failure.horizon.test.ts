import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaUploadedHandler } from "../../src/jobs/media/uploaded.js";
import { createOutboxRelay } from "../../src/jobs/outbox-relay.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { jpeg } from "../support/images.js";
import { seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

let fx: Fixture;
let ws: string;
let owner: string;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-upload-failure-"));
  fx = await startFixture({ storage: createFsDriver(dir) });
  const founder = await signedUser(fx, "upload-failure-org");
  owner = founder.id;
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

// An upload whose bytes are not in storage: every run of it fails, so only the claims of its event end it.
async function lostUpload(): Promise<string> {
  const id = randomUUID();
  const digest = createHash("sha256")
    .update(await jpeg())
    .digest();
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'p.jpg', 'image/jpeg', 'upload',
         $3::uuid, 'uploaded', $4, 1024)`,
      [id, ws, owner, digest],
    ),
  );
  return id;
}

describe("an upload whose run keeps failing", () => {
  it("ends processing_failed on its fail claim and never dead before it", async () => {
    const asset = await lostUpload();
    const event = randomUUID();
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.outbox (id, created_at, xid, type, workspace_id, payload)
         VALUES ($1, now(), '1'::xid8, 'media.uploaded', $2, $3)`,
        [event, ws, JSON.stringify({ media_id: asset })],
      ),
    );
    const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
    const deps = {
      pool: fx.db.pool("worker"),
      storage: createFsDriver(dir),
      scratchDir: join(dir, "scratch"),
      logger,
    };
    const relay = createOutboxRelay({
      pool: deps.pool,
      logger,
      handlers: { "media.uploaded": mediaUploadedHandler(deps) },
    });
    for (let claim = 1; claim <= 4; claim++) {
      await relay.tick();
      await fx.admin((client) =>
        client.query("UPDATE app.outbox SET claimed_until = now() - interval '1 second' WHERE id = $1", [
          event,
        ]),
      );
    }
    const [row] = (
      await fx.admin((client) =>
        client.query(
          `SELECT o.attempts, o.dispatched_at IS NOT NULL AS done, to_jsonb(o) ->> 'dead_at' AS dead,
             (SELECT a.state || '/' || a.reject_reason FROM app.media_assets a WHERE a.id = $2) AS asset
           FROM app.outbox o WHERE o.id = $1`,
          [event, asset],
        ),
      )
    ).rows;
    expect(row).toEqual({ attempts: 4, done: true, dead: null, asset: "rejected/processing_failed" });
  });
});
