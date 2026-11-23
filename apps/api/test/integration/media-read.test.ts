import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStorageEnv } from "@shoutory/core/config";
import type { StorageDriver } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageDriver } from "../../src/storage/driver.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { createBucket, s3Env } from "../support/s3.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The range read of an uploaded original: the same answers from the filesystem driver and from S3 (RFC 9110 14).

const BYTES = "0123456789";
const SHA = createHash("sha256").update(BYTES).digest("hex");
type Rig = {
  fx: Fixture;
  storage: StorageDriver;
  ws: string;
  asset: string;
  pending: string;
  viewer: string;
  outsider: string;
};
const rigs = new Map<string, Rig>();
let dir: string;

async function rig(name: "fs" | "s3", storage: StorageDriver): Promise<Rig> {
  const fx = await startFixture({ storage });
  const founder = await signedUser(fx, `read-${name}-org`);
  const ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  const viewer = await signedUser(fx, `read-${name}-viewer`);
  const outsider = await signedUser(fx, `read-${name}-outsider`);
  await addWorkspaceMember(fx, ws, viewer.id, "viewer");
  const plant = async (state: string) => {
    const id = randomUUID();
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256, byte_size, mime)
         VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'r.png', 'upload', $3::uuid,
           $4::text, CASE WHEN $4::text = 'pending_upload' THEN NULL ELSE decode($5, 'hex') END,
           CASE WHEN $4::text = 'pending_upload' THEN NULL ELSE 10 END, 'image/png')`,
        [id, ws, founder.id, state, SHA],
      ),
    );
    await storage.put(`ws/${ws}/${id}/1/original`, new Blob([BYTES]).stream(), 1024);
    return id;
  };
  return {
    fx,
    storage,
    ws,
    asset: await plant("uploaded"),
    pending: await plant("pending_upload"),
    viewer: viewer.cookie,
    outsider: outsider.cookie,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-media-read-"));
  rigs.set("fs", await rig("fs", createFsDriver(dir)));
  await createBucket("media-read-1");
  rigs.set("s3", await rig("s3", createStorageDriver(parseStorageEnv(s3Env("media-read-1")))));
});
afterAll(async () => {
  for (const { fx } of rigs.values()) await fx.close();
  await rm(dir, { recursive: true, force: true });
});

const read = (name: string, id: string, cookie: string, headers: Record<string, string> = {}) => {
  const r = rigs.get(name) as Rig;
  return r.fx.request(`/api/v1/workspaces/${r.ws}/media/${id}/original`, {
    method: "GET",
    headers: { cookie, ...headers },
  });
};

// [what is asked, request headers, status, body, Content-Range]
const range = (value: string, more: Record<string, string> = {}) => ({ range: value, ...more });
const ROWS: [string, Record<string, string>, number, string, string | null][] = [
  ["no range", {}, 200, BYTES, null],
  ["the first four bytes", range("bytes=0-3"), 206, "0123", "bytes 0-3/10"],
  ["from the middle to the end", range("bytes=3-"), 206, "3456789", "bytes 3-9/10"],
  ["the last four bytes (a suffix)", range("bytes=-4"), 206, "6789", "bytes 6-9/10"],
  ["an end past the size", range("bytes=5-99"), 206, "56789", "bytes 5-9/10"],
  ["a suffix longer than the object", range("bytes=-99"), 206, BYTES, "bytes 0-9/10"],
  ["a start at the size", range("bytes=10-"), 416, "", "bytes */10"],
  ["a start past the size", range("bytes=50-60"), 416, "", "bytes */10"],
  ["a suffix of zero bytes", range("bytes=-0"), 416, "", "bytes */10"],
  ["several ranges (served whole)", range("bytes=0-1,3-4"), 200, BYTES, null],
  ["an inverted range (served whole)", range("bytes=5-2"), 200, BYTES, null],
  ["an upper-case range unit", range("BYTES=0-3"), 206, "0123", "bytes 0-3/10"],
  [
    "an If-Range equal to the ETag",
    range("bytes=0-3", { "if-range": `"${SHA}"` }),
    206,
    "0123",
    "bytes 0-3/10",
  ],
  [
    "an If-Range that differs from the ETag (served whole)",
    range("bytes=0-3", { "if-range": '"other"' }),
    200,
    BYTES,
    null,
  ],
  [
    "an If-Range that is a date (served whole)",
    range("bytes=0-3", { "if-range": "Wed, 21 Oct 2015 07:28:00 GMT" }),
    200,
    BYTES,
    null,
  ],
];

describe.each(["fs", "s3"] as const)("%s driver: the range read of an original", (name) => {
  it.each(ROWS)(
    "answers %s with the status, bytes and Content-Range of RFC 9110",
    async (_label, headers, status, body, contentRange) => {
      const r = rigs.get(name) as Rig;
      const answer = await read(name, r.asset, r.viewer, headers);
      expect(answer.status).toBe(status);
      expect(await answer.text()).toBe(body);
      expect(answer.headers.get("content-range")).toBe(contentRange);
      if (status !== 416) {
        expect(answer.headers.get("etag")).toBe(`"${SHA}"`);
        expect(answer.headers.get("content-length")).toBe(String(body.length));
        expect(answer.headers.get("accept-ranges")).toBe("bytes");
        // Bytes a member uploaded are downloaded, never rendered as a page of this origin.
        expect(answer.headers.get("content-disposition")).toBe("attachment");
        expect(answer.headers.get("content-security-policy")).toBe("sandbox");
      }
    },
  );
});

// Who may read does not depend on the driver, so it runs on one rig.
it("lets a Viewer read, and answers an outsider, an asset still pending and an unknown asset with 404", async () => {
  const r = rigs.get("s3") as Rig;
  expect((await read("s3", r.asset, r.viewer)).status).toBe(200);
  expect((await read("s3", r.asset, r.outsider)).status).toBe(404);
  expect((await read("s3", r.pending, r.viewer)).status).toBe(404);
  expect((await read("s3", randomUUID(), r.viewer)).status).toBe(404);
});
