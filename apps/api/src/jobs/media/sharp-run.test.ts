import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { declaredPng, exifTags, hasExifSegment, jpeg } from "../../../test/support/images.js";
import { runSharpChild } from "./sharp-run.js";

// `spawn` is wrapped, not replaced: the real child runs, and the test reads the options it was started with.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

let dir: string;
let counter = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-sharp-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function stage(bytes: Buffer) {
  counter += 1;
  const inputPath = join(dir, `input-${counter}`);
  const outputDir = join(dir, `out-${counter}`);
  await writeFile(inputPath, bytes);
  await mkdir(outputDir);
  return { inputPath, outputDir };
}

describe("sharp runs with limitInputPixels", () => {
  it.each([
    [
      "10000 x 10000 (100 MP, a decompression bomb the default limit would admit)",
      10_000,
      10_000,
      "pixel_limit",
    ],
    ["7000 x 7000 (49 MP, inside the limit: refused only as bytes that are no image)", 7000, 7000, "corrupt"],
  ])("a decompression bomb is rejected: %s", async (_name, width, height, reason) => {
    const staged = await stage(declaredPng(width, height));
    expect(await runSharpChild(staged)).toEqual({ ok: false, reason });
    expect(await readdir(staged.outputDir)).toEqual([]);
  });
});

describe("EXIF GPS is gone from every derivative", () => {
  it("the input carries GPS, and neither derivative carries any EXIF", async () => {
    const original = await jpeg({ gps: true });
    const input = (await sharp(original).metadata()).exif as Buffer;
    expect(exifTags(input).gps).toEqual(expect.arrayContaining([1, 2, 3, 4]));

    const staged = await stage(original);
    const result = await runSharpChild(staged);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    for (const profile of ["stripped", "thumb"] as const) {
      const bytes = await readFile(result.files[profile]);
      expect(hasExifSegment(bytes), `${profile} holds an EXIF segment`).toBe(false);
      const meta = await sharp(bytes).metadata();
      expect([profile, meta.exif]).toEqual([profile, undefined]);
      expect(bytes.includes(Buffer.from("exif-canary-1"))).toBe(false);
    }
  });
});

describe("stripped is re-encoded at quality 90 for JPEG and WebP", () => {
  // Detailed pixels, so that quality decides the size; the same pixels re-encoded at sharp's default (80) are smaller.
  const pixels = Buffer.from(
    Array.from({ length: 128 * 128 * 3 }, (_, i) => (i * 7919 + (i >> 3) * 31) % 251),
  );
  const source = (format: "jpeg" | "webp") =>
    sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
      .toFormat(format, { quality: 100 })
      .toBuffer();
  it.each(["jpeg", "webp"] as const)("%s", async (format) => {
    const bytes = await source(format);
    const staged = await stage(bytes);
    const result = await runSharpChild(staged);
    if (!result.ok) throw new Error("the child refused the image");
    const stripped = await readFile(result.files.stripped);
    const atDefault = await sharp(bytes).rotate().toFormat(format).toBuffer();
    expect(stripped.length).toBeGreaterThan(atDefault.length);
  });
});

describe("the child gets no secrets and is killed at its time limit", () => {
  it("starts with an empty environment, whatever the server holds", async () => {
    process.env.SHOUTORY_CANARY = "canary-secret-1";
    try {
      const staged = await stage(await jpeg());
      const result = await runSharpChild(staged);
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain("canary-secret-1");
      const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as { env?: Record<string, string> };
      expect(options.env).toEqual({});
    } finally {
      delete process.env.SHOUTORY_CANARY;
    }
  });

  it("kills a child that outlasts its limit and answers a timeout, leaving no process", async () => {
    const staged = await stage(await jpeg());
    expect(await runSharpChild({ ...staged, timeoutMs: 1 })).toEqual({ ok: false, reason: "timeout" });
    const pid = vi.mocked(spawn).mock.results.at(-1)?.value.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(staged.outputDir)).toEqual([]);
  });

  it("kills a child whose caller gave up (an aborted signal), leaving no process and no file, and throws", async () => {
    const staged = await stage(await jpeg());
    const controller = new AbortController();
    const pending = runSharpChild({ ...staged, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    const pid = vi.mocked(spawn).mock.results.at(-1)?.value.pid as number;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(staged.outputDir)).toEqual([]);
  });
});
