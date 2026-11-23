import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClamdScan, encodeInstream, parseClamdReply } from "./scan.js";

// The clamd INSTREAM protocol (clamd man page): the command `zINSTREAM\0`, then chunks each led by its length as four
// bytes in network order, then a chunk of length zero. The encoder and the reply reader are pure; the socket is the
// operator's scanner and is not faked here.
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

describe("the clamd frame encoder", () => {
  it.each([
    ["an empty file", Buffer.alloc(0), [Buffer.from("zINSTREAM\0"), u32(0)]],
    ["one small chunk", Buffer.from("abc"), [Buffer.from("zINSTREAM\0"), u32(3), Buffer.from("abc"), u32(0)]],
  ])("frames %s", (_name, bytes, frames) => {
    expect(Buffer.concat(encodeInstream(bytes))).toEqual(Buffer.concat(frames));
  });

  it("splits a large file into chunks of at most 64 KiB and ends with the zero chunk", () => {
    const frames = encodeInstream(Buffer.alloc(150_000, 7));
    const lengths = frames.slice(1).flatMap((frame, i) => (i % 2 === 0 ? [frame.readUInt32BE(0)] : []));
    expect(lengths).toEqual([65_536, 65_536, 18_928, 0]);
    expect(Buffer.concat(frames).length).toBe(10 + 150_000 + 4 * 4);
  });
});

describe("a scanner that cannot be reached", () => {
  it("makes the scan throw, for the caller to log, and never answers clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shoutory-scan-"));
    try {
      await writeFile(join(dir, "file"), "bytes");
      // Nothing listens on port 1.
      await expect(createClamdScan({ host: "127.0.0.1", port: 1 })(join(dir, "file"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the clamd reply", () => {
  it.each([
    ["stream: OK\0", "clean"],
    ["stream: Eicar-Test-Signature FOUND\0", "found"],
    ["INSTREAM size limit exceeded. ERROR\0", "failed"],
    ["", "failed"],
    ["something unexpected\0", "failed"],
  ])("reads %j as %s", (reply, verdict) => {
    expect(parseClamdReply(Buffer.from(reply))).toBe(verdict);
  });
});
