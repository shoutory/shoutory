import { createServer, type Server, type Socket } from "node:net";

export interface SmtpSink {
  readonly url: string;
  readonly messages: string[];
  connections: number;
  /** Answers 554 with the whole message echoed. */
  reject: boolean;
  /** While set, a finished message is not answered: the sender sees a server that hangs. */
  hold: boolean;
  onMessage: (() => void) | undefined;
  release(): void;
  close(): Promise<void>;
}

const END_OF_DATA = "\r\n.\r\n";
// Folded header lines are joined first (RFC 5322 3.2.2), then the soft breaks and `=3D` of quoted-printable go.
const decoded = (raw: string): string =>
  raw
    .replaceAll(/\r\n(?=[ \t])/g, "")
    .replaceAll("=\r\n", "")
    .replaceAll("=3D", "=");

const REPLIES: Readonly<Record<string, string>> = { EHLO: "250 sink.test\r\n" };

function command(socket: Socket, line: string, startData: () => void): void {
  const verb = line.slice(0, 4).toUpperCase();
  if (verb === "DATA") {
    startData();
    socket.write("354 go ahead\r\n");
  } else if (verb === "QUIT") socket.end("221 bye\r\n");
  else socket.write(REPLIES[verb] ?? "250 ok\r\n");
}

function serve(socket: Socket, sink: SmtpSink, held: Array<() => void>): void {
  let data: string | undefined;
  const finish = (raw: string) => {
    const message = decoded(raw.slice(0, -END_OF_DATA.length));
    if (sink.reject) return void socket.write(`554 rejected ${message.replaceAll(/\s+/g, " ")}\r\n`);
    const answer = () => {
      sink.messages.push(message);
      sink.onMessage?.();
      socket.write("250 queued\r\n");
    };
    if (sink.hold) held.push(answer);
    else answer();
  };
  socket.write("220 sink.test ESMTP\r\n");
  socket.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (data === undefined) {
      for (const line of text.split("\r\n").filter(Boolean)) command(socket, line, () => (data = ""));
      return;
    }
    data += text;
    if (!data.endsWith(END_OF_DATA)) return;
    const raw = data;
    data = undefined;
    finish(raw);
  });
  socket.on("error", () => undefined);
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const sockets = new Set<Socket>();
  const held: Array<() => void> = [];
  const sink: SmtpSink = {
    url: "",
    messages: [],
    connections: 0,
    reject: false,
    hold: false,
    onMessage: undefined,
    release: () => {
      sink.hold = false;
      for (const answer of held.splice(0)) answer();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((socket) => {
    sink.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, sink, held);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return Object.assign(sink, { url: `smtp://127.0.0.1:${port}?requireTLS=false` });
}
