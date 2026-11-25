import { createHash, randomUUID } from "node:crypto";
import { ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { parseStorageEnv, type StorageConfig } from "@shoutory/core/config";
import { StorageError } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageDriver } from "../../src/storage/driver.js";
import { createS3Multipart, createS3Presigner } from "../../src/storage/s3-driver.js";
import { createBucket, S3_ACCESS_KEY, S3_SECRET_KEY, s3Env, s3Url } from "../support/s3.js";

const BUCKET = "s3-multipart-1";
const MIB = 1024 * 1024;
const config = () => parseStorageEnv(s3Env(BUCKET)) as Extract<StorageConfig, { driver: "s3" }>;
let driver: ReturnType<typeof createStorageDriver>;
let multipart: ReturnType<typeof createS3Multipart>;
let presigner: ReturnType<typeof createS3Presigner>;

beforeAll(async () => {
  await createBucket(BUCKET);
  driver = createStorageDriver(config());
  multipart = createS3Multipart(config());
  presigner = createS3Presigner(config());
});
afterAll(() => driver.close?.());

const keyOf = () => `ws/${randomUUID()}/${randomUUID()}/1/original`;
const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const filled = (length: number, text: string) => Buffer.alloc(length, text);

async function putPart(key: string, uploadId: string, number: number, body: Buffer, signedFor = body) {
  const signed = await presigner.presignPart(key, uploadId, number, signedFor.length, hex(signedFor));
  const answer = await fetch(signed.url, { method: "PUT", body, headers: signed.headers });
  return { status: answer.status, code: /<Code>([^<]*)<\/Code>/.exec(await answer.text())?.[1] };
}

async function twoParts(key: string) {
  const { uploadId } = await multipart.createUpload(key);
  for (const [index, body] of [filled(5 * MIB, "part-one-"), filled(1024, "part-two-")].entries())
    expect((await putPart(key, uploadId, index + 1, body)).status).toBe(200);
  return { uploadId, size: 5 * MIB + 1024 };
}

describe("an upload goes part by part through presigned URLs", () => {
  it("of 5 MiB + 1 KiB completes into one object of that size, the parts listed as storage holds them", async () => {
    const key = keyOf();
    const { uploadId, size } = await twoParts(key);
    const parts = await multipart.listParts(key, uploadId);
    expect(parts?.map(({ number, size: length }) => [number, length])).toEqual([
      [1, 5 * MIB],
      [2, 1024],
    ]);
    await multipart.complete(key, uploadId, parts ?? [], size);
    expect(await driver.head(key)).toMatchObject({ size });
  });

  it("refuses a body that differs from the sha256 the URL signs", async () => {
    const key = keyOf();
    const { uploadId } = await multipart.createUpload(key);
    const sent = await putPart(key, uploadId, 1, filled(2048, "wrong-bytes-"), filled(2048, "right-bytes-"));
    expect(sent).toEqual({ status: 400, code: "BadDigest" });
  });
});

describe("complete never replaces an original and never accepts a size it was not told", () => {
  it("answers exists for a key that holds an object, and the first bytes stay (floor)", async () => {
    const key = keyOf();
    await driver.put(key, new Blob(["first"]).stream(), 1024, { ifAbsent: true });
    const { uploadId, size } = await twoParts(key);
    const parts = (await multipart.listParts(key, uploadId)) ?? [];
    await expect(multipart.complete(key, uploadId, parts, size)).rejects.toMatchObject({ kind: "exists" });
    expect(await driver.head(key)).toMatchObject({ size: 5 });
  });

  it("refuses a wrong object size, stores nothing and leaves the upload open", async () => {
    const key = keyOf();
    const { uploadId, size } = await twoParts(key);
    const parts = (await multipart.listParts(key, uploadId)) ?? [];
    await expect(multipart.complete(key, uploadId, parts, size + 1)).rejects.toBeInstanceOf(StorageError);
    expect(await driver.head(key)).toBeNull();
    expect(await multipart.listParts(key, uploadId)).not.toBeNull();
  });
});

describe("a finished or aborted upload has no parts to list", () => {
  it("answers null after abort and after complete", async () => {
    const [aborted, completed] = [keyOf(), keyOf()];
    const first = await twoParts(aborted);
    await multipart.abort(aborted, first.uploadId);
    expect(await multipart.listParts(aborted, first.uploadId)).toBeNull();
    const second = await twoParts(completed);
    const parts = (await multipart.listParts(completed, second.uploadId)) ?? [];
    await multipart.complete(completed, second.uploadId, parts, second.size);
    expect(await multipart.listParts(completed, second.uploadId)).toBeNull();
    // A complete of an upload that is already done is not an error: the caller reads the object to settle it.
    await expect(multipart.complete(completed, second.uploadId, parts, second.size)).resolves.toBeUndefined();
  });
});

const LARGE = 64 * MIB + 1;

// One MiB at a time, each chunk named by its place, so a part stored out of order changes the digest.
function largeBody(size: number, failAfter = Infinity) {
  const hash = createHash("sha256");
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= failAfter) return controller.error(new Error("the source broke"));
      if (sent >= size) return controller.close();
      const chunk = filled(Math.min(MIB, size - sent), `chunk-${sent / MIB}-`);
      hash.update(chunk);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return { body, digest: () => hash.digest("hex") };
}

async function stored(key: string) {
  const body = await driver.get(key);
  const hash = createHash("sha256");
  if (body) for await (const chunk of body) hash.update(chunk);
  return hash.digest("hex");
}

async function openUploads(key: string) {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: s3Url(),
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });
  try {
    const answer = await client.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: key }));
    return answer.Uploads ?? [];
  } finally {
    client.destroy();
  }
}

describe("a put above 64 MiB goes in parts the driver sends itself", () => {
  it("stores 64 MiB + 1 as one object with the same bytes", async () => {
    const key = keyOf();
    const { body, digest } = largeBody(LARGE);
    await driver.put(key, body, LARGE);
    expect(await driver.head(key)).toMatchObject({ size: LARGE });
    expect(await stored(key)).toBe(digest());
  });

  it.each([
    ["a source that breaks after 85 MiB, once parts are stored", 100 * MIB, 85 * MIB, "failed"],
    ["a source longer than its bound", 70 * MIB, Infinity, "too_large"],
  ])("leaves no object and no open upload after %s", async (_name, maxBytes, failAfter, kind) => {
    const key = keyOf();
    const { body } = largeBody(90 * MIB, failAfter);
    await expect(driver.put(key, body, maxBytes)).rejects.toMatchObject({ kind });
    expect(await driver.head(key)).toBeNull();
    expect(await openUploads(key)).toEqual([]);
  });

  it.each([
    ["answers exists and keeps the first bytes when it must not replace", true, "exists"],
    ["replaces the object otherwise", false, null],
  ])("over an existing object %s", async (_name, ifAbsent, kind) => {
    const key = keyOf();
    await driver.put(key, new Blob(["first"]).stream(), 1024);
    const { body, digest } = largeBody(LARGE);
    const put = driver.put(key, body, LARGE, { ifAbsent });
    if (kind) await expect(put).rejects.toMatchObject({ kind });
    else await put;
    expect(await driver.head(key)).toMatchObject({ size: kind ? 5 : LARGE });
    if (!kind) expect(await stored(key)).toBe(digest());
    expect(await openUploads(key)).toEqual([]);
  });
});
