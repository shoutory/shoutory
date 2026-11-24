import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type EgressRequest, egressFetch } from "@shoutory/provider-sdk/egress";
import { createOperatorPolicy } from "@shoutory/provider-sdk/egress/policy";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordGuard } from "../../../src/auth/hibp.js";

const HOST = "api.pwnedpasswords.com";
const BREACHED = "hibp-breached-password-1";
const CLEAN = "hibp-clean-password-1";
const hashOf = (password: string) => createHash("sha1").update(password).digest("hex").toUpperCase();

const asked: { path: string; padding: string | undefined }[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    asked.push({ path: req.url ?? "", padding: req.headers["add-padding"] as string | undefined });
    const prefix = (req.url ?? "").split("/").pop() ?? "";
    const hit = hashOf(BREACHED);
    const lines = hit.startsWith(prefix) ? [`${hit.slice(5)}:7`] : [];
    res.end([...lines, "0000000000000000000000000000000000A:0"].join("\r\n"));
  });
  port = await listenLoopback(server);
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

// Only the scheme and port are rewritten, to reach the loopback simulator.
function guard(hosts: readonly string[] = [HOST]) {
  const operator = createOperatorPolicy({
    allowCidrs: ["127.0.0.0/8"],
    ports: [port],
    schemes: ["http:"],
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const fetchRange = (request: EgressRequest) =>
    egressFetch(
      { ...request, url: request.url.replace("https://", "http://").replace(HOST, `${HOST}:${port}`) },
      { request: { kind: "provider", egressHosts: hosts }, operator },
    );
  const pools = {} as never;
  const quiet = () => undefined;
  const logger = { info: quiet, warn: quiet, error: quiet, child: () => logger };
  return createPasswordGuard({ fetch: fetchRange, pool: pools, appPool: pools, logger });
}

describe("the breached-password check on the egress client", () => {
  it("refuses a breached hash prefix and lets a clean one pass, sending only the prefix", async () => {
    asked.length = 0;
    const subject = guard();
    await expect(subject.screen(BREACHED)).rejects.toMatchObject({
      details: { reason: "password_breached" },
    });
    await expect(subject.screen(CLEAN)).resolves.toBe("clean");
    expect(asked.map((row) => row.path)).toEqual([
      `/range/${hashOf(BREACHED).slice(0, 5)}`,
      `/range/${hashOf(CLEAN).slice(0, 5)}`,
    ]);
    expect(asked.every((row) => row.padding === "true")).toBe(true);
  });

  it("answers unavailable, without a request reaching the server, when the host is not on the provider list", async () => {
    asked.length = 0;
    await expect(guard(["other.example"]).screen(CLEAN)).resolves.toBe("unavailable");
    expect(asked).toEqual([]);
  });
});
