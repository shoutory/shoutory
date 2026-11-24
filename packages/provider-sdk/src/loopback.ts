import type { Server } from "node:net";

// The ports the Fetch Standard blocks: `fetch` refuses to connect to one with "bad port", whatever listens there
// (https://fetch.spec.whatwg.org/#port-blocking, accessed 2026-11-21). A server that listens on port 0 can be given
// one when the operating system's dynamic range reaches below 10080 (it starts at 1024 on Windows hosts), so a test
// server that a test then fetches must listen through `listenLoopback`.
const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isFetchBlockedPort = (port: number): boolean => BLOCKED_PORTS.has(port);

// Far more than the handful of attempts a blocked draw ever needs; a stuck host fails the test loudly.
const MAX_ATTEMPTS = 100;

const listenOnce = (server: Server, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

const closeOnce = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

export async function listenLoopback(server: Server, host = "127.0.0.1"): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = await listenOnce(server, host);
    if (!isFetchBlockedPort(port)) return port;
    await closeOnce(server);
  }
  throw new Error("the host only assigned ports that fetch refuses");
}
