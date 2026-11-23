import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStorageEnv, type StorageConfig } from "@shoutory/core/config";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageDriver } from "../../src/storage/driver.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { createS3Presigner } from "../../src/storage/s3-driver.js";
import { createBucket, s3Env } from "../support/s3.js";

// The drivers against real storage: the filesystem driver on a folder, the S3 driver on the simulator. The first table
// runs on both; the rest is the filesystem driver's own (its root, its links).
const MAX = 1024;
const BUCKET = "driver-table-1";
const ABSENT_ONLY = { "if-none-match": "*" };
const stream = (text: string) => new Blob([text]).stream();
const read = async (body: ReadableStream<Uint8Array> | null) =>
  body === null ? null : new TextDecoder().decode(await new Response(body).arrayBuffer());

let base: string;
let root: string;
let outside: string;
let driver: StorageDriver;
const pick = (name: "fs" | "s3"): StorageDriver =>
  name === "fs" ? driver : createStorageDriver(parseStorageEnv(s3Env(BUCKET)));
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "shoutory-fs-driver-"));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "outside-secret-1");
  // A directory link: it is how a path inside the root could lead out of it.
  await symlink(outside, join(root, "link"), "junction");
  driver = createFsDriver(root);
  await createBucket(BUCKET);
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe.each(["fs", "s3"] as const)("%s driver: put, get, delete", (name) => {
  it("round trips an object, replaces it and deletes it; a missing key reads null and deletes quietly", async () => {
    const shared = pick(name);
    await shared.put("media/a1", stream("first"), MAX);
    expect(await read(await shared.get("media/a1"))).toBe("first");
    await shared.put("media/a1", stream("second"), MAX);
    expect(await read(await shared.get("media/a1"))).toBe("second");
    await shared.delete("media/a1");
    expect(await shared.get("media/a1")).toBeNull();
    expect(await shared.get("media/never-written")).toBeNull();
    expect(await shared.get("no-folder/never-written")).toBeNull();
    await expect(shared.delete("media/never-written")).resolves.toBeUndefined();
  });

  it("refuses a body over maxBytes, leaves nothing and keeps the object it would have replaced", async () => {
    const shared = pick(name);
    await shared.put("limited/kept", stream("kept"), MAX);
    await expect(shared.put("limited/kept", stream("x".repeat(11)), 10)).rejects.toMatchObject({
      kind: "too_large",
    });
    const fresh = shared.put("limited/fresh", stream("x".repeat(11)), 10);
    await expect(fresh).rejects.toBeInstanceOf(StorageError);
    expect(await read(await shared.get("limited/kept"))).toBe("kept");
    expect(await shared.get("limited/fresh")).toBeNull();
    await shared.delete("limited/kept");
  });
});

describe.each(["fs", "s3"] as const)("%s driver: ifAbsent", (name) => {
  it("refuses a second write and keeps the first bytes, also against an object written without ifAbsent", async () => {
    const shared = pick(name);
    await shared.put("original/a1", stream("first"), MAX, { ifAbsent: true });
    await expect(shared.put("original/a1", stream("second!"), MAX, { ifAbsent: true })).rejects.toMatchObject(
      {
        kind: "exists",
      },
    );
    expect(await read(await shared.get("original/a1"))).toBe("first");
    await shared.put("original/plain", stream("plain"), MAX);
    await expect(
      shared.put("original/plain", stream("other"), MAX, { ifAbsent: true }),
    ).rejects.toMatchObject({
      kind: "exists",
    });
    expect(await read(await shared.get("original/plain"))).toBe("plain");
    await shared.delete("original/a1");
    await shared.delete("original/plain");
  });

  it("lets exactly one of two simultaneous writers win and keeps the winner's bytes", async () => {
    const shared = pick(name);
    const settled = await Promise.allSettled([
      shared.put("original/race", stream("writer-one"), MAX, { ifAbsent: true }),
      shared.put("original/race", stream("writer-two"), MAX, { ifAbsent: true }),
    ]);
    const winners = settled.flatMap((result, index) => (result.status === "fulfilled" ? [index] : []));
    expect(winners).toHaveLength(1);
    const loser = settled[1 - (winners[0] as number)] as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ kind: "exists" });
    expect(await read(await shared.get("original/race"))).toBe(
      winners[0] === 0 ? "writer-one" : "writer-two",
    );
    await shared.delete("original/race");
  });

  it("leaves a refused write's temporary bytes nowhere and the next ifAbsent write after a delete succeeds", async () => {
    const shared = pick(name);
    await shared.put("original/again", stream("one"), MAX, { ifAbsent: true });
    await expect(shared.put("original/again", stream("two"), MAX, { ifAbsent: true })).rejects.toMatchObject({
      kind: "exists",
    });
    if (name === "fs") expect(await readdir(join(root, "original"))).toEqual(["again"]);
    await shared.delete("original/again");
    await shared.put("original/again", stream("three"), MAX, { ifAbsent: true });
    expect(await read(await shared.get("original/again"))).toBe("three");
    await shared.delete("original/again");
    if (name === "fs") expect(await readdir(join(root, "original"))).toEqual([]);
  });
});

describe.each(["fs", "s3"] as const)("%s driver: head and ranged get", (name) => {
  it("reports the size or null, and returns exactly the bytes asked: first, middle, last and past the end", async () => {
    const shared = pick(name);
    await shared.put("ranged/a1", stream("0123456789"), MAX);
    expect(await shared.head("ranged/a1")).toEqual({ size: 10 });
    expect(await shared.head("ranged/missing")).toBeNull();
    expect(await shared.head("no-folder/missing")).toBeNull();
    const rows: [number, number, string][] = [
      [0, 0, "0"],
      [3, 5, "345"],
      [9, 9, "9"],
      [5, 99, "56789"],
    ];
    for (const [start, end, expected] of rows)
      expect(await read(await shared.get("ranged/a1", { start, end }))).toBe(expected);
    // A start past the end is an empty answer, not a failure.
    expect(await read(await shared.get("ranged/a1", { start: 10, end: 20 }))).toBe("");
    expect(await read(await shared.get("ranged/a1", { start: 50, end: 60 }))).toBe("");
    for (const [start, end] of [
      [-1, 2],
      [5, 2],
      [1.5, 3],
      [0, Number.NaN],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ] as const)
      await expect(shared.get("ranged/a1", { start, end })).rejects.toMatchObject({ kind: "invalid_key" });
    expect(await shared.get("ranged/missing", { start: 0, end: 1 })).toBeNull();
    await shared.delete("ranged/a1");
  });
});

describe("s3 driver: a presigned PUT", () => {
  it("stores the bytes at 14 minutes and answers 403 at 16 minutes; another key or a changed length is refused", async () => {
    const config = parseStorageEnv(s3Env(BUCKET)) as Extract<StorageConfig, { driver: "s3" }>;
    const presigner = createS3Presigner(config);
    const store = pick("s3");
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const put = async (url: string, body: string, headers: Record<string, string> = ABSENT_ONLY) =>
      (await fetch(url, { method: "PUT", body, headers })).status;

    const fresh = await presigner.presignPut("presigned/a1", 5, minutesAgo(14));
    expect(await put(fresh, "12345")).toBe(200);
    expect(await read(await store.get("presigned/a1"))).toBe("12345");

    const stale = await presigner.presignPut("presigned/a2", 5, minutesAgo(16));
    expect(await put(stale, "12345")).toBe(403);
    expect(await store.get("presigned/a2")).toBeNull();

    expect(await put(fresh.replace("presigned/a1", "presigned/a3"), "12345")).toBe(403);
    expect(await store.get("presigned/a3")).toBeNull();

    const sized = await presigner.presignPut("presigned/a4", 5, new Date());
    expect(await put(sized, "123456")).toBe(403);
    expect(await store.get("presigned/a4")).toBeNull();

    // An original is never replaced through the URL either: a second PUT with the same URL is refused, and a PUT that
    // leaves out the signed header is refused too.
    expect(await put(fresh, "abcde")).toBe(412);
    expect(await read(await store.get("presigned/a1"))).toBe("12345");
    const bare = await presigner.presignPut("presigned/a5", 5, new Date());
    expect(await put(bare, "12345", {})).toBe(403);
    expect(await store.get("presigned/a5")).toBeNull();
    await store.delete("presigned/a1");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("refuses the length %s", async (length) => {
    const config = parseStorageEnv(s3Env(BUCKET)) as Extract<StorageConfig, { driver: "s3" }>;
    await expect(createS3Presigner(config).presignPut("presigned/a6", length)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("fs driver: a refused put leaves no temporary file", () => {
  it("leaves the folder empty", async () => {
    await expect(driver.put("temp-free/a1", stream("x".repeat(11)), 10)).rejects.toBeInstanceOf(StorageError);
    expect(await readdir(join(root, "temp-free"))).toEqual([]);
  });
});

describe("fs driver: a key never leaves the root", () => {
  it.each([
    ["a parent segment", "../escaped", "invalid_key"],
    ["a parent segment in the middle", "a/../../escaped", "invalid_key"],
    ["an absolute path", "/escaped", "invalid_key"],
    ["a NUL byte", "a\u0000b", "invalid_key"],
    ["a backslash", "..\\escaped", "invalid_key"],
    ["a link that leads outside", "link/escaped", "outside_root"],
  ])("refuses %s on put, get and delete and writes nothing outside", async (_name, key, kind) => {
    await expect(driver.put(key, stream("planted"), MAX)).rejects.toMatchObject({ kind });
    await expect(driver.get(key)).rejects.toMatchObject({ kind });
    await expect(driver.delete(key)).rejects.toMatchObject({ kind });
    expect(await readdir(outside)).toEqual(["secret"]);
    expect(await readdir(base)).toEqual(["outside", "root"]);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside-secret-1");
  });

  it("refuses to read or delete a file through the link", async () => {
    await expect(driver.get("link/secret")).rejects.toMatchObject({ kind: "outside_root" });
    await expect(driver.delete("link/secret")).rejects.toMatchObject({ kind: "outside_root" });
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside-secret-1");
  });
});

describe("fs driver: a missing root", () => {
  it("refuses a write and does not create the root or anything under it", async () => {
    const absent = join(base, "not-mounted");
    const refused: unknown = await createFsDriver(absent)
      .put("media/a1", stream("data"), MAX)
      .catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ kind: "failed" });
    expect(String(refused)).not.toContain("not-mounted");
    expect(await readdir(base)).not.toContain("not-mounted");
  });
});

describe("fs driver: check", () => {
  it("reports the free bytes of the root, and null when the root does not exist", async () => {
    const { freeBytes } = await driver.check();
    expect(freeBytes).toBeGreaterThan(0);
    expect((await createFsDriver(join(base, "missing")).check()).freeBytes).toBeNull();
  });
});
