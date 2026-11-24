import { randomUUID } from "node:crypto";
import { lstat, lutimes, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepStaleFiles } from "../../src/storage/fs-sweep.js";

const DAY = 86_400_000;
const NOW = new Date("2026-11-24T03:23:00Z");
let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "shoutory-fs-sweep-"));
  root = join(base, "data");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dirname(root), { recursive: true, force: true });
});

const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
async function plant(path: string, days: number): Promise<string> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, "stale-part-1");
  await utimes(full, ago(days), ago(days));
  return full;
}
// A junction on Windows, which needs no privilege.
async function link(path: string, target: string, days: number): Promise<string> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await symlink(target, full, "junction");
  await lutimes(full, ago(days), ago(days));
  return full;
}
const there = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const TMP = (name: string) => `.${name}.${randomUUID()}.tmp`;

describe("what the sweeper removes after 7 days", () => {
  it("removes a part and a temporary leftover 8 days old, and keeps what is younger, an original, a link and what lies outside ws/", async () => {
    const old = await plant("ws/w1/m1/parts/1", 8);
    const oldPartTemp = await plant(`ws/w1/m1/parts/${TMP("2")}`, 8);
    const oldTemp = await plant(`ws/w1/m1/1/${TMP("original")}`, 8);
    const kept = [
      await plant("ws/w1/m1/parts/3", 6),
      await plant(`ws/w1/m1/1/${TMP("thumb")}`, 6),
      await plant("ws/w1/m1/1/original", 30),
      await plant("ws/w1/m1/1/.notes.tmp", 30),
      await plant("other/parts/1", 30),
    ];
    const strangerFile = await plant("elsewhere/secret", 30);
    await writeFile(join(outside, "old-file"), "outside-file-1");
    await utimes(join(outside, "old-file"), ago(30), ago(30));
    kept.push(await link("ws/w1/m1/parts/4", outside, 30), await link("ws/w1/m2/parts", outside, 30));
    const answer = await sweepStaleFiles(root, NOW);
    expect(answer).toMatchObject({ removed: 3, cut: false });
    expect(answer.visited).toBeGreaterThan(0);
    for (const path of [old, oldPartTemp, oldTemp]) expect(await there(path), path).toBe(false);
    for (const path of [...kept, strangerFile, join(outside, "old-file")])
      expect(await there(path), path).toBe(true);
  });

  it("removes a parts folder that is empty and 8 days old, and keeps one that still holds a younger part", async () => {
    await plant("ws/w1/m1/parts/1", 8);
    await utimes(join(root, "ws/w1/m1/parts"), ago(8), ago(8));
    await plant("ws/w1/m2/parts/1", 1);
    await sweepStaleFiles(root, NOW);
    expect(await there(join(root, "ws/w1/m1/parts"))).toBe(false);
    expect(await there(join(root, "ws/w1/m2/parts/1"))).toBe(true);
    expect(await there(join(root, "ws/w1/m1"))).toBe(true);
  });
});

describe("what bounds the sweeper", () => {
  it("stops at its deadline: a walk with no time left removes nothing and says it was cut", async () => {
    const old = await plant("ws/w1/m1/parts/1", 8);
    expect(await sweepStaleFiles(root, NOW, { deadlineMs: 0 })).toMatchObject({ removed: 0, cut: true });
    expect(await there(old)).toBe(true);
  });

  // The clock moves at every read, so a short deadline admits a few folders and cuts the walk.
  it("a cut walk starts at another folder on another day, so a stale file in the last folders is reached", async () => {
    for (const n of [1, 2, 3, 4]) await mkdir(join(root, `ws/w1/m${n}`), { recursive: true });
    const stale = [await plant("ws/w1/m5/parts/1", 30), await plant("ws/w1/m6/parts/1", 30)];
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1));
    // Six folders, and a walk that admits about four after it listed them: a walk that always began at the first folder
    // never reaches m5 or m6.
    for (let day = 0; day < 6; day++)
      await sweepStaleFiles(root, new Date(NOW.getTime() + day * DAY), { deadlineMs: 12 });
    for (const path of stale) expect(await there(path), path).toBe(false);
  });

  it("reads the deadline while it lists a folder, so a long listing is cut too", async () => {
    const stale = await plant("ws/w1/m1/parts/1", 30);
    for (let n = 0; n < 40; n++) await writeFile(join(root, `ws/w1/entry-${n}`), "not-a-folder-1");
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 10));
    expect(await sweepStaleFiles(root, NOW, { deadlineMs: 25 })).toMatchObject({ removed: 0, cut: true });
    expect(await there(stale)).toBe(true);
  });

  it("sweeps nothing through a ws/ that is a link", async () => {
    const stale = join(outside, "w1/m1/parts/1");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "stale-part-1");
    await utimes(stale, ago(30), ago(30));
    await link("ws", outside, 30);
    expect(await sweepStaleFiles(root, NOW)).toEqual({ removed: 0, visited: 0, cut: false });
    expect(await there(stale)).toBe(true);
  });

  it("answers with nothing visited for a data folder that has no ws/ yet", async () => {
    expect(await sweepStaleFiles(root, NOW)).toEqual({ removed: 0, visited: 0, cut: false });
  });
});
