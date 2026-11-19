import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";

// The filesystem driver against a real folder. The S3 driver joins the first table in its own slice.
const MAX = 1024;
const stream = (text: string) => new Blob([text]).stream();
const read = async (body: ReadableStream<Uint8Array> | null) =>
  body === null ? null : new TextDecoder().decode(await new Response(body).arrayBuffer());

let base: string;
let root: string;
let outside: string;
let driver: StorageDriver;
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
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe("fs driver: put, get, delete", () => {
  it("round trips an object, replaces it and deletes it; a missing key reads null and deletes quietly", async () => {
    await driver.put("media/a1", stream("first"), MAX);
    expect(await read(await driver.get("media/a1"))).toBe("first");
    await driver.put("media/a1", stream("second"), MAX);
    expect(await read(await driver.get("media/a1"))).toBe("second");
    await driver.delete("media/a1");
    expect(await driver.get("media/a1")).toBeNull();
    expect(await driver.get("media/never-written")).toBeNull();
    expect(await driver.get("no-folder/never-written")).toBeNull();
    await expect(driver.delete("media/never-written")).resolves.toBeUndefined();
  });

  it("refuses a body over maxBytes, leaves nothing and keeps the object it would have replaced", async () => {
    await driver.put("limited/kept", stream("kept"), MAX);
    await expect(driver.put("limited/kept", stream("x".repeat(11)), 10)).rejects.toMatchObject({
      kind: "too_large",
    });
    const fresh = driver.put("limited/fresh", stream("x".repeat(11)), 10);
    await expect(fresh).rejects.toBeInstanceOf(StorageError);
    expect(await read(await driver.get("limited/kept"))).toBe("kept");
    expect(await driver.get("limited/fresh")).toBeNull();
    expect(await readdir(join(root, "limited"))).toEqual(["kept"]);
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
    await expect(createFsDriver(absent).put("media/a1", stream("data"), MAX)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
