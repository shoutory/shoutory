import { createReadStream } from "node:fs";
import { connect, type Socket } from "node:net";

// The scanner's address is the operator's own setting, never a value a workspace names, so this connection is an
// operator egress exception. The protocol is INSTREAM, from the clamd man page.

export type ScanVerdict = "clean" | "found" | "skipped" | "failed";
export type Scan = (path: string) => Promise<ScanVerdict>;

const CHUNK_BYTES = 65_536;
const CONNECT_AND_READ_MS = 30_000;
const MAX_REPLY_BYTES = 1024;

export function parseClamdReply(reply: Buffer): ScanVerdict {
  // clamd ends every reply with NUL; one cut short by a timeout or a dropped connection is not an answer.
  const end = reply.indexOf(0);
  if (end < 0) return "failed";
  const text = reply.toString("latin1", 0, end);
  if (/^stream: OK$/.test(text)) return "clean";
  if (/^stream: .+ FOUND$/.test(text)) return "found";
  // clamd stops reading a stream longer than its StreamMaxLength and says so: the file was not scanned.
  return /size limit exceeded/i.test(text) ? "skipped" : "failed";
}

const lengthOf = (chunk: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(chunk.length);
  return length;
};
const drained = (socket: Socket) =>
  new Promise<void>((done) => {
    const settle = () => {
      socket.off("drain", settle).off("close", settle);
      done();
    };
    socket.once("drain", settle).once("close", settle);
  });

// A chunk is read only once the socket has taken the one before, so a run holds one chunk, never the file.
async function send(socket: Socket, path: string): Promise<void> {
  socket.write("zINSTREAM\0");
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>) {
    if (!socket.writable) return;
    socket.write(lengthOf(chunk));
    if (!socket.write(chunk)) await drained(socket);
  }
  if (socket.writable) socket.write(Buffer.alloc(4));
}

function ask(host: string, port: number, path: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    const socket = connect({ host, port });
    const parts: Buffer[] = [];
    let size = 0;
    socket.setTimeout(CONNECT_AND_READ_MS, () => socket.destroy(new Error("the scanner timed out")));
    socket.once(
      "connect",
      () => void send(socket, path).catch((error: unknown) => socket.destroy(error as Error)),
    );
    socket.on("data", (data: Buffer) => {
      size += data.length;
      parts.push(data);
      if (size > MAX_REPLY_BYTES) socket.destroy(new Error("the scanner's reply is too long"));
    });
    // Listened to for the whole life of the socket. clamd may answer and close while the file is still being sent; the
    // error that write then meets leaves the answer to be read, and only an error before any answer fails the scan.
    socket.on("error", (error) => {
      if (size === 0) fail(error);
    });
    socket.once("close", () => done(Buffer.concat(parts)));
  });
}

export function createClamdScan(settings: { readonly host: string; readonly port: number }): Scan {
  return async (path) => parseClamdReply(await ask(settings.host, settings.port, path));
}
