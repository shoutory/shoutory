import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectMedia } from "../../src/jobs/media/gc.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { seedChannel, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

let fx: Fixture;
let dir: string;
let real: ReturnType<typeof createFsDriver>;
let owner: string;
let wsA: string;
let wsB: string;
let channelA: string;
let channelB: string;
const lines: string[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
const failing = new Set<string>();
const deleted: string[] = [];

const storage: StorageDriver = {
  name: "fs",
  put: (...args) => real.put(...args),
  get: (...args) => real.get(...args),
  head: (...args) => real.head(...args),
  check: () => real.check(),
  async delete(key) {
    deleted.push(key);
    if (failing.has(key)) throw new StorageError("failed");
    await real.delete(key);
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-media-gc-"));
  real = createFsDriver(dir);
  fx = await startFixture({ storage: real });
  const founder = await signedUser(fx, "media-gc-org");
  owner = founder.id;
  const org = await seedOrganization(fx, owner);
  [wsA, wsB] = [await seedWorkspace(fx, org), await seedWorkspace(fx, org)];
  [channelA, channelB] = [await seedChannel(fx, wsA), await seedChannel(fx, wsB)];
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

interface Planted {
  id?: string;
  ws?: string;
  state?: string;
  ageDays?: number;
  deletedDays?: number;
  library?: boolean;
}
interface Asset {
  id: string;
  ws: string;
  key: string;
  derivativeKey: string;
}
async function plantAsset(o: Planted = {}): Promise<Asset> {
  const [id, ws, state] = [o.id ?? randomUUID(), o.ws ?? wsA, o.state ?? "ready"];
  const [key, derivativeKey] = [`ws/${ws}/${id}/1/original`, `ws/${ws}/${id}/1/thumb`];
  await fx.admin(async (client) => {
    await client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256,
         created_at, in_library, deleted_at)
       VALUES ($1::uuid, $2::uuid, $3, 'gc.png', 'upload', $4::uuid, $5::text,
         CASE WHEN $5::text IN ('uploaded', 'scanning', 'processing', 'ready') THEN sha256(convert_to($1::text, 'UTF8')) END,
         now() - make_interval(secs => $6::float8 * 86400), $7,
         CASE WHEN $5::text = 'deleted' THEN now() - make_interval(secs => $8::float8 * 86400) END)`,
      [id, ws, key, owner, state, o.ageDays ?? 31, o.library ?? false, o.deletedDays ?? 31],
    );
    await client.query(
      `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, 'thumb', $3, 'ready', sha256(convert_to($2::text || 'thumb', 'UTF8')), 5)`,
      [ws, id, derivativeKey],
    );
  });
  for (const stored of [key, derivativeKey]) {
    await real.put(stored, new Blob([new Uint8Array(Buffer.from("object-bytes"))]).stream(), 1024);
  }
  return { id, ws, key, derivativeKey };
}
const stored = async (key: string) => (await real.head(key)) !== null;
const rowOf = async (id: string) =>
  (
    await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT state, object_removed_at IS NOT NULL AS removed FROM app.media_assets WHERE id = $1",
            [id],
          )
        ).rows,
    )
  )[0] as { state: string; removed: boolean };

async function variantIn(ws: string): Promise<string> {
  const channel = ws === wsA ? channelA : channelB;
  return fx.admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
        [ws, owner],
      )
    ).rows[0].id;
    return (
      await client.query(
        "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'draft') RETURNING id",
        [ws, post, channel],
      )
    ).rows[0].id as string;
  });
}
const BLOCKED = { blocked_since: new Date(), reason_code: "pending" };
// An operation in `state` that sends the asset, planted with the triggers off so that the state is not the result of a move.
async function pin(asset: Asset, state: string, extra: Record<string, unknown> = {}): Promise<void> {
  const variant = await variantIn(asset.ws);
  const channel = asset.ws === wsA ? channelA : channelB;
  const columns: Record<string, unknown> = {
    workspace_id: asset.ws,
    variant_id: variant,
    channel_id: channel,
    provider_id: "fixture-oauth",
    queue: "publish.fixture-oauth",
    kind: "publish",
    part_index: 0,
    state,
    last_actor: "S",
    due_at: new Date(),
    lateness_deadline: new Date(Date.now() + 7_200_000),
    idempotency_marker: `gc-${randomUUID()}`,
    requested_by: owner,
    effect: ["published", "provider_accepted"].includes(state) ? "confirmed" : "none",
    blocked_since: state === "blocked_reconnect" ? BLOCKED.blocked_since : null,
    reason_code: state === "blocked_reconnect" ? BLOCKED.reason_code : null,
    ...extra,
  };
  const names = Object.keys(columns);
  await fx.admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = (
      await client.query(
        `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        Object.values(columns),
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_sha256)
       VALUES ($1, $2, 0, $3, decode(repeat('ab', 32), 'hex'))`,
      [asset.ws, op, asset.id],
    );
    await client.query("COMMIT");
  });
}
async function reference(asset: Asset): Promise<void> {
  const variant = await variantIn(asset.ws);
  await fx.admin((client) =>
    client.query(
      "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, 0, $3)",
      [asset.ws, variant, asset.id],
    ),
  );
}
const run = (options?: { limit?: number }) =>
  collectMedia({ pool: fx.db.pool("worker"), storage, logger }, options);

type Holder = (asset: Asset) => Promise<unknown>;
const PINNED: [string, Planted, Holder][] = [
  // One row per kind of pin, end to end through the take; every state of an operation is a row of the db package, once,
  // against the one rule the candidate list and the take share.
  ["a post that names it", {}, reference],
  ["an operation that can still send it", {}, (asset) => pin(asset, "claimed")],
  ["the library", { library: true }, async () => undefined],
  [
    "the avatar of its workspace",
    {},
    (asset) =>
      fx.admin((client) =>
        client.query("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [asset.ws, asset.id]),
      ),
  ],
];

describe("the garbage collection never deletes media that something still needs (floor)", () => {
  it.each(PINNED)("%s keeps the asset and both objects", async (_what, planted, hold) => {
    const asset = await plantAsset(planted);
    await hold(asset);
    await run();
    expect(await rowOf(asset.id)).toMatchObject({ state: planted.state ?? "ready", removed: false });
    expect([await stored(asset.key), await stored(asset.derivativeKey)]).toEqual([true, true]);
    expect(deleted).not.toContain(asset.key);
  });
});

describe("the garbage collection removes what nothing needs, in each arm", () => {
  it.each([
    ["a pending upload 25 hours old", { state: "pending_upload", ageDays: 25 / 24 }, true],
    ["a pending upload 23 hours old", { state: "pending_upload", ageDays: 23 / 24 }, false],
    ["a ready asset 31 days old that nothing uses", { ageDays: 31 }, true],
    ["a ready asset 29 days old", { ageDays: 29 }, false],
    ["a rejected asset 31 days old", { state: "rejected", ageDays: 31 }, true],
    ["a rejected asset 29 days old", { state: "rejected", ageDays: 29 }, false],
    ["a deleted asset 31 days after its deletion", { state: "deleted", deletedDays: 31 }, true],
    ["a deleted asset 29 days after its deletion", { state: "deleted", deletedDays: 29 }, false],
  ] as [string, Planted, boolean][])("%s", async (_what, planted, collected) => {
    const asset = await plantAsset(planted);
    await run();
    expect(await rowOf(asset.id)).toMatchObject({ removed: collected });
    expect([await stored(asset.key), await stored(asset.derivativeKey)]).toEqual(
      collected ? [false, false] : [true, true],
    );
  });
});

describe("the garbage collection keeps every workspace's objects to itself (floor)", () => {
  it("removes each workspace's object under its own prefix only, and a second run removes nothing more", async () => {
    const [a, b] = [await plantAsset({ ws: wsA }), await plantAsset({ ws: wsB })];
    const before = deleted.length;
    await run();
    for (const asset of [a, b]) {
      expect(await rowOf(asset.id)).toMatchObject({ state: "deleted", removed: true });
      const own = deleted.slice(before).filter((key) => key.includes(`/${asset.id}/`));
      expect(own.sort()).toEqual([asset.key, asset.derivativeKey].sort());
      expect(own.every((key) => key.startsWith(`ws/${asset.ws}/`))).toBe(true);
      // Its emptied folders go with it, up to the workspace's own folder, which stays.
      expect([
        existsSync(join(dir, "ws", asset.ws, asset.id)),
        existsSync(join(dir, "ws", asset.ws)),
      ]).toEqual([false, true]);
    }
    const second = deleted.length;
    await run();
    expect(deleted.slice(second).filter((key) => key.includes(a.id) || key.includes(b.id))).toEqual([]);
  });
});

describe("a failed delete of an object never stops the run (floor)", () => {
  it("leaves that asset deleted with its original, still removes its derivatives and the others, and logs the asset without its key", async () => {
    const [bad, good] = [await plantAsset(), await plantAsset()];
    failing.add(bad.key);
    const before = lines.length;
    try {
      await run();
    } finally {
      failing.delete(bad.key);
    }
    expect(await rowOf(bad.id)).toMatchObject({ state: "deleted", removed: false });
    expect([await stored(bad.key), await stored(bad.derivativeKey)]).toEqual([true, false]);
    expect(await rowOf(good.id)).toMatchObject({ state: "deleted", removed: true });
    expect([await stored(good.key), await stored(good.derivativeKey)]).toEqual([false, false]);
    const log = lines.slice(before).join("\n");
    expect(log).toContain(bad.id);
    expect(log).not.toContain(bad.key);
    expect(log).not.toContain(`ws/${bad.ws}`);
  });

  // The list is ordered by asset id and holds `limit` candidates: as many candidates whose delete keeps failing (deleted
  // assets, which stay candidates until their object is gone) as the list holds must not keep a later candidate from
  // being collected in the same run.
  it("still collects a candidate listed after as many failing candidates as one list holds", async () => {
    const failed = await Promise.all(
      [1, 2, 3].map((n) =>
        plantAsset({ id: `00000000-0000-4000-8000-00000000000${n}`, state: "deleted", deletedDays: 31 }),
      ),
    );
    const later = await plantAsset({ id: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    for (const asset of failed) failing.add(asset.key);
    try {
      await run({ limit: 3 });
    } finally {
      for (const asset of failed) failing.delete(asset.key);
    }
    expect(await rowOf(later.id)).toMatchObject({ state: "deleted", removed: true });
    for (const asset of failed) expect(await rowOf(asset.id)).toMatchObject({ removed: false });
  });
});
