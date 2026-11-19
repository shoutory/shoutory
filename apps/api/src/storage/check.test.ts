import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageDriver } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStorage } from "./check.js";
import { createFsDriver } from "./fs-driver.js";

let dir: string;
let real: StorageDriver;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-storage-check-"));
  real = createFsDriver(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const fails = async () => {
  throw new Error("planted failure naming /some/secret/path");
};
const hangs = () => new Promise<never>(() => undefined);
const other = async () => new Blob(["not the probe bytes"]).stream();

// One component of a real driver misbehaves per row; the rest still works.
const ROWS: [string, Partial<StorageDriver>, boolean, boolean, string][] = [
  ["the write fails", { put: fails }, false, false, "write_failed"],
  ["the read fails", { get: fails }, true, false, "read_failed"],
  ["the read returns other bytes", { get: other }, true, false, "read_failed"],
  ["the object is missing when read back", { get: async () => null }, true, false, "read_failed"],
  ["the delete fails", { delete: fails }, true, true, "delete_failed"],
  ["the read never answers", { get: hangs }, true, false, "timeout"],
];

describe("storage check: a failing probe is a class, never error text", () => {
  it.each(ROWS)("%s", async (_name, broken, writable, readable, failure) => {
    const driver = { ...real, ...broken };
    const answer = await checkStorage(driver, { timeoutMs: 100 });
    expect(answer).toMatchObject({ driver: "fs", writable, readable, failure });
    expect(JSON.stringify(answer)).not.toContain("secret");
  });
});
