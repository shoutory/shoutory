import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepScratch } from "./scratch.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-scratch-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-25T12:00:00Z");
const MINUTE = 60_000;

describe("the scratch sweep at worker start", () => {
  it("removes a run's folder left for more than an hour and keeps fresh folders and what is not a run's", async () => {
    const scratch = join(dir, "sweep");
    const plant = async (name: string, ageMinutes: number, folder = true) => {
      const path = join(scratch, name);
      if (folder) await mkdir(join(path, "inner"), { recursive: true });
      else await writeFile(path, "bytes");
      const at = new Date(NOW - ageMinutes * MINUTE);
      await utimes(path, at, at);
    };
    await mkdir(scratch, { recursive: true });
    await plant("shoutory-media-stale", 61);
    await plant("shoutory-media-fresh", 59);
    await plant("operator-folder", 600);
    await plant("operator-file", 600, false);
    await sweepScratch(scratch, NOW);
    expect((await readdir(scratch)).sort()).toEqual([
      "operator-file",
      "operator-folder",
      "shoutory-media-fresh",
    ]);
  });

  it("creates the scratch folder when it does not exist", async () => {
    const scratch = join(dir, "new", "scratch");
    await sweepScratch(scratch, NOW);
    expect(await readdir(scratch)).toEqual([]);
  });
});
