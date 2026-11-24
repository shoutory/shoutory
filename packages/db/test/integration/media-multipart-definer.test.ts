import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, digestOf, seedMembers, U, WA, WB } from "../support/members-seed.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const MIB = 1024 * 1024;
const PART_SIZE = 16 * MIB;
const SIZE = 100 * MIB;
const DIGEST = digestOf("multipart-declared-1");
const UPLOAD_ID = "storage-upload-id-1";

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

interface Planted {
  ws?: string;
  state?: string;
  session?: boolean;
}
async function plantUpload(o: Planted = {}): Promise<string> {
  const id = randomUUID();
  const ws = o.ws ?? WA;
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256)
     VALUES ($1, $2, $3, 'big.bin', 'upload', $4, $5, CASE WHEN $5 = 'pending_upload' THEN NULL ELSE $6::bytea END)`,
    [id, ws, `ws/${ws}/${id}/1/original`, U.editor, o.state ?? "pending_upload", digestOf(id)],
  );
  if (o.session !== false)
    await rows(
      `INSERT INTO app.media_uploads (workspace_id, media_id, part_size, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [ws, id, PART_SIZE],
    );
  return id;
}
const record = (
  ws: string,
  asset: string,
  uploadId = UPLOAD_ID,
  digest: Buffer | null = DIGEST,
  size = SIZE,
) =>
  ["SELECT app.media_set_multipart($1, $2, $3, $4, $5) AS id", [ws, asset, uploadId, digest, size]] as const;
const stored = async (asset: string) =>
  (
    await rows(
      "SELECT multipart_upload_id, declared_sha256, declared_size::float8 AS declared_size FROM app.media_uploads WHERE media_id = $1",
      [asset],
    )
  )[0];

describe("media_set_multipart records the upload id, digest and size once", () => {
  it("stores the three values together, and a repeat of the same values answers the stored id", async () => {
    const asset = await plantUpload();
    const [sql, params] = record(WA, asset);
    expect(await commitAs(db.pool("app"), U.editor, sql, [...params])).toEqual([{ id: UPLOAD_ID }]);
    expect(await commitAs(db.pool("app"), U.editor, sql, [...params])).toEqual([{ id: UPLOAD_ID }]);
    expect(await stored(asset)).toEqual({
      multipart_upload_id: UPLOAD_ID,
      declared_sha256: DIGEST,
      declared_size: SIZE,
    });
  });

  it("refuses a second call with another upload id, another digest or another size (SH409) and keeps the first", async () => {
    const asset = await plantUpload();
    const [sql, params] = record(WA, asset);
    await commitAs(db.pool("app"), U.editor, sql, [...params]);
    for (const other of [
      record(WA, asset, "storage-upload-id-2"),
      record(WA, asset, UPLOAD_ID, digestOf("multipart-declared-2")),
      record(WA, asset, UPLOAD_ID, DIGEST, SIZE + 1),
    ]) {
      const refused = await attempt(db.pool("app"), asUser(U.editor), other[0], [...other[1]]);
      expect(refused.error).toMatchObject({ code: "SH409" });
    }
    expect((await stored(asset))?.multipart_upload_id).toBe(UPLOAD_ID);
  });
});

describe("media_set_multipart refuses who may not record and what is not an open pending upload", () => {
  // A refusal for another workspace's asset is the same one an unknown asset gets.
  const WORKER_JOB = { principalKind: "job", principalId: randomUUID(), workspaceIds: [WA] } as const;
  it.each([
    ["a viewer", asUser(U.viewer), {}, "42501"],
    ["a job principal (there is no job path)", WORKER_JOB, {}, "42501"],
    ["an asset of another workspace", asUser(U.editor), { ws: WB }, "42501"],
    ["an asset that is not pending", asUser(U.editor), { state: "uploaded" }, "SH409"],
    ["an asset with no upload session", asUser(U.editor), { session: false }, "SH409"],
  ] as const)("a call for %s is refused", async (_name, ctx, planted, code) => {
    const asset = await plantUpload(planted);
    const [sql, params] = record(WA, asset);
    const pool = ctx.principalKind === "job" ? db.pool("worker") : db.pool("app");
    const refused = await attempt(pool, ctx, sql, [...params]);
    expect(refused.error).toMatchObject({ code });
    expect((await stored(asset))?.multipart_upload_id ?? null).toBeNull();
  });

  it.each([
    ["a digest of 31 bytes", { digest: DIGEST.subarray(0, 31) }],
    ["no digest", { digest: null }],
    ["a size of zero", { size: 0 }],
    ["a size above 5 GiB", { size: 5 * 1024 * MIB + 1 }],
    ["an empty upload id", { uploadId: "" }],
  ])("a call with %s is 22023 and stores nothing", async (_name, change) => {
    const asset = await plantUpload();
    const [sql, params] = record(
      WA,
      asset,
      "uploadId" in change ? change.uploadId : UPLOAD_ID,
      "digest" in change ? change.digest : DIGEST,
      "size" in change ? change.size : SIZE,
    );
    const refused = await attempt(db.pool("app"), asUser(U.editor), sql, [...params]);
    expect(refused.error).toMatchObject({ code: "22023" });
    expect((await stored(asset))?.multipart_upload_id ?? null).toBeNull();
  });
});
