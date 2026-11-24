import { readFile } from "node:fs/promises";
import { connect } from "node:net";

// The scanner's address is the operator's own setting, never a value a workspace names, so this connection is an
// operator egress exception. The protocol is INSTREAM, from the clamd man page.

export type ScanVerdict = "clean" | "found" | "failed";
export type Scan = (path: string) => Promise<ScanVerdict>;

const CHUNK_BYTES = 65_536;
const CONNECT_AND_READ_MS = 30_000;
const MAX_REPLY_BYTES = 1024;

export function encodeInstream(bytes: Uint8Array): Buffer[] {
  const frames = [Buffer.from("zINSTREAM\0")];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    const chunk = bytes.subarray(at, at + CHUNK_BYTES);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length);
    frames.push(length, Buffer.from(chunk));
  }
  frames.push(Buffer.alloc(4));
  return frames;
}

export function parseClamdReply(reply: Buffer): ScanVerdict {
  const text = reply.toString("latin1").split("\0")[0] ?? "";
  if (/^stream: OK$/.test(text)) return "clean";
  return /^stream: .+ FOUND$/.test(text) ? "found" : "failed";
}

function ask(host: string, port: number, frames: Buffer[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    const socket = connect({ host, port });
    const parts: Buffer[] = [];
    let size = 0;
    socket.setTimeout(CONNECT_AND_READ_MS, () => socket.destroy(new Error("the scanner timed out")));
    socket.once("connect", () => socket.write(Buffer.concat(frames)));
    socket.on("data", (data: Buffer) => {
      size += data.length;
      parts.push(data);
      if (size > MAX_REPLY_BYTES) socket.destroy(new Error("the scanner's reply is too long"));
    });
    // Listened to for the whole life of the socket: an error after the first (a reset while destroying) must not escape.
    socket.on("error", fail);
    socket.once("close", () => done(Buffer.concat(parts)));
  });
}

export function createClamdScan(settings: { readonly host: string; readonly port: number }): Scan {
  return async (path) =>
    parseClamdReply(await ask(settings.host, settings.port, encodeInstream(await readFile(path))));
}
