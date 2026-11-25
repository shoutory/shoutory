import { once } from "node:events";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClamdScan, parseClamdReply } from "./scan.js";

// The real stream, watched, so a test can see how much of the file the scan has read.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});

let dir: string;
const servers: Server[] = [];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-scan-"));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileOf(size: number): Promise<string> {
  const path = join(dir, `file-${size}`);
  await writeFile(path, Buffer.alloc(size, 7));
  return path;
}

// A stand-in for clamd on a loopback port, which hears the request as it arrives and acts as each test says.
async function clamd(hear: (socket: Socket, received: Buffer) => void): Promise<number> {
  const server = createServer((socket) => {
    let received = Buffer.alloc(0);
    // The client may reset the socket this test closes; that is the client's error, asserted by the test.
    socket.on("error", () => undefined);
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      hear(socket, received);
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// The chunk lengths of a whole INSTREAM request, or undefined while its zero chunk has not arrived.
function chunksOf(received: Buffer): number[] | undefined {
  const lengths: number[] = [];
  for (let at = "zINSTREAM\0".length; at + 4 <= received.length; ) {
    const length = received.readUInt32BE(at);
    lengths.push(length);
    if (length === 0) return lengths;
    at += 4 + length;
  }
  return undefined;
}

describe("the clamd request", () => {
  it.each([
    ["an empty file", 0, [0]],
    ["one small chunk", 3, [3, 0]],
    ["a file larger than one chunk", 150_000, [65_536, 65_536, 18_928, 0]],
  ])(
    "sends %s in chunks of at most 64 KiB, ends with the zero chunk, and reads the answer",
    async (_n, size, lengths) => {
      let heard: number[] | undefined;
      const port = await clamd((socket, received) => {
        heard = chunksOf(received);
        if (heard) socket.end("stream: OK\0");
      });
      expect(await createClamdScan({ host: "127.0.0.1", port })(await fileOf(size))).toBe("clean");
      expect(heard).toEqual(lengths);
    },
  );

  it("is skipped, not failed, when clamd stops reading at its stream limit and answers so", async () => {
    let answered = false;
    const port = await clamd((socket, received) => {
      if (answered || received.length < 100_000) return;
      answered = true;
      socket.end("INSTREAM size limit exceeded. ERROR\0");
    });
    expect(await createClamdScan({ host: "127.0.0.1", port })(await fileOf(4 * 1024 * 1024))).toBe("skipped");
  });

  it("reads the file only as fast as clamd takes it, so a scan never holds the whole file", async () => {
    const size = 32 * 1024 * 1024;
    let held: Socket | undefined;
    const server = createServer((socket) => {
      socket.pause();
      held = socket;
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const verdict = createClamdScan({ host: "127.0.0.1", port })(await fileOf(size));
    await new Promise((done) => setTimeout(done, 500));
    const read = vi.mocked(createReadStream).mock.results.at(-1)?.value as ReadStream;
    expect(read.bytesRead).toBeLessThan(size / 2);
    // The command, each 64 KiB chunk with its length, and the zero chunk.
    const whole = "zINSTREAM\0".length + size + 4 * (size / 65_536) + 4;
    let received = 0;
    held?.on("data", (data: Buffer) => {
      received += data.length;
      if (received === whole) held?.end("stream: OK\0");
    });
    held?.resume();
    expect(await verdict).toBe("clean");
  });

  it("rejects, for the caller to log, when clamd resets the connection before it answers", async () => {
    const port = await clamd((socket) => socket.resetAndDestroy());
    await expect(createClamdScan({ host: "127.0.0.1", port })(await fileOf(1024 * 1024))).rejects.toThrow();
  });
});

describe("a scanner that cannot be reached", () => {
  it("makes the scan throw, for the caller to log, and never answers clean", async () => {
    // Nothing listens on port 1.
    await expect(createClamdScan({ host: "127.0.0.1", port: 1 })(await fileOf(5))).rejects.toThrow();
  });
});

describe("the clamd reply", () => {
  it.each([
    ["stream: OK\0", "clean"],
    ["stream: Eicar-Test-Signature FOUND\0", "found"],
    ["INSTREAM size limit exceeded. ERROR\0", "skipped"],
    ["", "failed"],
    ["stream: OK", "failed"],
    ["something unexpected\0", "failed"],
  ])("reads %j as %s", (reply, verdict) => {
    expect(parseClamdReply(Buffer.from(reply))).toBe(verdict);
  });
});
