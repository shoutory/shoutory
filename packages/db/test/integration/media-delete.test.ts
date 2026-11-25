import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

let channel: string;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    channel = (
      await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name)
         VALUES ($1, 'fixture-oauth', 'profile', 'delete-channel', 'delete-channel') RETURNING id`,
        [WA],
      )
    ).rows[0].id;
  });
});
afterAll(() => db.drop());
afterEach(() => rows("UPDATE app.workspaces SET avatar = NULL WHERE id = $1", [WA]));

const EDITOR = asUser(U.editor);
const DELETE = "SELECT app.media_delete($1, $2)";

async function plantAsset(state = "ready", library = false): Promise<string> {
  const id = randomUUID();
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256, in_library)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'delete.png', 'upload', $3, $4::text,
       CASE WHEN $4::text <> 'pending_upload' THEN sha256(convert_to($1::text, 'UTF8')) END, $5)`,
    [id, WA, U.editor, state, library],
  );
  return id;
}
const assetOf = async (id: string) =>
  (await rows("SELECT state, in_library, deleted_at FROM app.media_assets WHERE id = $1", [id]))[0];
const attachedTo = async (id: string) =>
  (await rows("SELECT 1 FROM app.post_media WHERE media_id = $1", [id])).length;

async function variantIn(): Promise<string> {
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
    [WA, U.editor],
  );
  const [variant] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'draft') RETURNING id",
    [WA, post?.id, channel],
  );
  return variant?.id as string;
}
const ATTACH =
  "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, 0, $3)";
const attach = async (asset: string) => rows(ATTACH, [WA, await variantIn(), asset]);
async function pin(asset: string, state: string): Promise<void> {
  const variant = await variantIn();
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, last_actor,
         due_at, lateness_deadline, idempotency_marker, requested_by)
       VALUES ($1, $2, $3, 'fixture-oauth', 'publish.pin', 'publish', $4, 'S', now(), now() + interval '2 hours', $5, $6)
       RETURNING id`,
      [WA, variant, channel, state, `delete-pin-${randomUUID()}`, U.editor],
    );
    await client.query(
      `INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_sha256)
       VALUES ($1, $2, 0, $3, decode(repeat('ab', 32), 'hex'))`,
      [WA, op.rows[0].id, asset],
    );
    await client.query("COMMIT");
  });
}
const avatar = (asset: string) => rows("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [WA, asset]);

async function commitDelete(asset: string): Promise<void> {
  const client = await openTx(db.pool("app"), EDITOR);
  try {
    await client.query(DELETE, [WA, asset]);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function untilSomeoneWaits(): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    const waiting = await rows(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = $1`,
      [db.name],
    );
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("nobody waited for the lock");
}

describe("delete refuses a medium something still uses (floor)", () => {
  const HELD: [string, (asset: string) => Promise<unknown>][] = [
    ["a post names it", attach],
    ["a pending operation pins it", (asset) => pin(asset, "pending")],
    ["it is the workspace avatar", avatar],
  ];
  it.each(HELD)(
    "when %s it is refused as in_use and the medium stays ready and in the library",
    async (_what, hold) => {
      const asset = await plantAsset("ready", true);
      await hold(asset);
      const answer = await attempt(db.pool("app"), EDITOR, DELETE, [WA, asset]);
      expect(answer.error).toMatchObject({ code: "SH409", message: "media_delete: in_use" });
      expect(await assetOf(asset)).toMatchObject({ state: "ready", in_library: true, deleted_at: null });
    },
  );

  it.each([
    ["a ready medium in the library", "ready", true, null],
    ["a rejected medium", "rejected", false, null],
    ["a medium a published operation once sent", "ready", false, "published"],
  ] as [string, string, boolean, string | null][])(
    "%s nothing else uses is deleted and leaves the library",
    async (_what, state, library, pinnedBy) => {
      const asset = await plantAsset(state, library);
      if (pinnedBy) await pin(asset, pinnedBy);
      await commitDelete(asset);
      const row = await assetOf(asset);
      expect([row?.state, row?.in_library, row?.deleted_at !== null]).toEqual(["deleted", false, true]);
    },
  );

  it.each([
    ["pending_upload", "SH409"],
    ["uploaded", "SH409"],
    ["scanning", "SH409"],
    ["processing", "SH409"],
    ["deleted", "42501"],
  ])("a medium in state %s is refused with %s and left as it is", async (state, code) => {
    const asset = await plantAsset(state);
    const before = await assetOf(asset);
    const answer = await attempt(db.pool("app"), EDITOR, DELETE, [WA, asset]);
    expect(answer.error).toMatchObject({ code });
    if (code === "SH409") expect(answer.error).toMatchObject({ message: "media_delete: not_deletable" });
    expect(await assetOf(asset)).toEqual(before);
  });
});

describe("a delete racing an attach never leaves a deleted medium attached (race, floor)", () => {
  it("a delete that meets an attach still uncommitted waits for it and is refused as in_use", async () => {
    const asset = await plantAsset();
    const variant = await variantIn();
    const answer = await admin(async (writer) => {
      await writer.query("BEGIN");
      await writer.query(ATTACH, [WA, variant, asset]);
      const deleting = attempt(db.pool("app"), EDITOR, DELETE, [WA, asset]);
      await untilSomeoneWaits();
      await writer.query("COMMIT");
      return deleting;
    });
    expect(answer.error).toMatchObject({ code: "SH409", message: "media_delete: in_use" });
    expect([(await assetOf(asset))?.state, await attachedTo(asset)]).toEqual(["ready", 1]);
  });

  it("an attach that meets a delete still uncommitted waits for it, is refused, and writes no post_media", async () => {
    const asset = await plantAsset();
    const variant = await variantIn();
    const holder = await openTx(db.pool("app"), EDITOR);
    const error = await admin(async (writer) => {
      await holder.query(DELETE, [WA, asset]);
      const attaching = writer.query(ATTACH, [WA, variant, asset]).catch((caught: unknown) => caught);
      await untilSomeoneWaits();
      await holder.query("COMMIT");
      holder.release();
      return attaching;
    });
    expect(error).toMatchObject({ code: "SH422", message: "post: media_unavailable" });
    expect([(await assetOf(asset))?.state, await attachedTo(asset)]).toEqual(["deleted", 0]);
  });
});
