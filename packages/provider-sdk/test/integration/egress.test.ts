import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { egressFetch } from "../../src/egress/client.js";
import { EgressError } from "../../src/egress/errors.js";
import { createOperatorPolicy } from "../../src/egress/policy.js";
import { listenLoopback } from "../../src/loopback.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let port = 0;
let connections = 0;
let servedOn: string[] = [];
let handler: Handler = (_req, res) => res.end("ok");

beforeEach(async () => {
  connections = 0;
  handler = (_req, res) => res.end("ok");
  server = createServer((req, res) => handler(req, res));
  servedOn = [];
  server.on("connection", (socket) => {
    connections += 1;
    servedOn.push(socket.localAddress ?? "");
  });
  // Listening on every IPv4 address lets a test prove that no connection reached 127.0.0.2.
  port = await listenLoopback(server, "0.0.0.0");
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function stubLookup(answers: Record<string, string[][]>) {
  const calls: Record<string, number> = {};
  const lookup = async (hostname: string) => {
    const queue = answers[hostname] ?? [];
    const index = Math.min(calls[hostname] ?? 0, queue.length - 1);
    calls[hostname] = (calls[hostname] ?? 0) + 1;
    return (queue[index] ?? []).map((address) => ({
      address,
      family: address.includes(":") ? (6 as const) : (4 as const),
    }));
  };
  return { lookup, calls };
}

const policyOf = (allowCidrs: string[], lookup: ReturnType<typeof stubLookup>["lookup"]) => ({
  request: { kind: "user_url" } as const,
  operator: createOperatorPolicy({ allowCidrs, ports: [port], schemes: ["http:"], lookup }),
});

async function refusal(promise: Promise<unknown>): Promise<EgressError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EgressError);
  return error as EgressError;
}

describe("egressFetch connect pinning", () => {
  it("a hostname whose answer holds one blocked address is refused whole, with no connection opened", async () => {
    const dns = stubLookup({ "mixed.test": [["93.184.216.34", "127.0.0.1"]] });
    const failure = await refusal(
      egressFetch({ url: `http://mixed.test:${port}/` }, policyOf([], dns.lookup)),
    );
    expect(failure.host).toBe("mixed.test");
    expect(connections).toBe(0);
  });

  it("an answer with an unreachable address first still connects to the next checked address", async () => {
    const dns = stubLookup({ "family.test": [["::1", "127.0.0.1"]] });
    const reply = await egressFetch(
      { url: `http://family.test:${port}/` },
      policyOf(["127.0.0.0/8", "::1/128"], dns.lookup),
    );
    expect(reply.status).toBe(200);
    expect(servedOn).toEqual(["127.0.0.1"]);
  });
});

describe("egressFetch one lookup per connection", () => {
  it("looks up once and connects only to the checked address, never to a later answer", async () => {
    const dns = stubLookup({ "pin.test": [["127.0.0.1"], ["169.254.169.254"]] });
    const reply = await egressFetch(
      { url: `http://pin.test:${port}/` },
      policyOf(["127.0.0.0/8"], dns.lookup),
    );
    expect(reply.status).toBe(200);
    expect(dns.calls["pin.test"]).toBe(1);
    expect(connections).toBe(1);
  });

  it.each(["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1"])(
    "an answer of %s is refused at connect under an empty allowlist, with zero connections",
    async (address) => {
      const dns = stubLookup({ "loop.test": [[address]] });
      await refusal(egressFetch({ url: `http://loop.test:${port}/` }, policyOf([], dns.lookup)));
      expect(connections).toBe(0);
    },
  );
});

describe("egressFetch redirects", () => {
  it.each(["file:///etc/hosts", "gopher://hop.test/x", "ftp://hop.test/x"])(
    "a redirect hop to %s is refused",
    async (location) => {
      const dns = stubLookup({ "hop.test": [["127.0.0.1"]] });
      handler = (_req, res) => res.writeHead(302, { location }).end();
      await refusal(egressFetch({ url: `http://hop.test:${port}/` }, policyOf(["127.0.0.0/8"], dns.lookup)));
    },
  );
});

describe("egressFetch credentials across hops", () => {
  it("drops Authorization, Cookie and Proxy-Authorization on a cross-host hop", async () => {
    const dns = stubLookup({ "a.test": [["127.0.0.1"]], "b.test": [["127.0.0.1"]] });
    const seen: Record<string, IncomingMessage["headers"]> = {};
    handler = (req, res) => {
      seen[req.headers.host ?? ""] = req.headers;
      if (req.headers.host?.startsWith("a.test"))
        res.writeHead(302, { location: `http://b.test:${port}/` }).end();
      else res.end("ok");
    };
    const headers = {
      authorization: "Bearer redirect-token-1",
      cookie: "sid=redirect-cookie-1",
      "proxy-authorization": "Basic redirect-proxy-1",
      "x-api-key": "redirect-key-1",
    };
    await egressFetch({ url: `http://a.test:${port}/`, headers }, policyOf(["127.0.0.0/8"], dns.lookup));
    expect(seen[`a.test:${port}`]?.authorization).toBe(headers.authorization);
    const second = seen[`b.test:${port}`];
    expect(second).toBeDefined();
    expect(second?.authorization).toBeUndefined();
    expect(second?.cookie).toBeUndefined();
    expect(second?.["proxy-authorization"]).toBeUndefined();
    expect(second?.["x-api-key"]).toBeUndefined();
  });

  it("a redirect to a private address is refused at the second hop", async () => {
    const dns = stubLookup({ "hop.test": [["127.0.0.1"]] });
    handler = (req, res) => {
      const location = req.url === "/start" ? "/second" : `http://127.0.0.2:${port}/internal`;
      res.writeHead(302, { location }).end();
    };
    const failure = await refusal(
      egressFetch({ url: `http://hop.test:${port}/start` }, policyOf(["127.0.0.1/32"], dns.lookup)),
    );
    expect(failure.class).toBe("blocked_address");
    expect(servedOn).not.toContain("127.0.0.2");
  });

  it("a redirect to a name that resolves to metadata is refused", async () => {
    const dns = stubLookup({ "hop.test": [["127.0.0.1"]], "meta.test": [["169.254.169.254"]] });
    handler = (_req, res) => res.writeHead(302, { location: `http://meta.test:${port}/` }).end();
    await refusal(egressFetch({ url: `http://hop.test:${port}/` }, policyOf(["127.0.0.0/8"], dns.lookup)));
  });

  it("follows three redirects and refuses the fourth", async () => {
    const dns = stubLookup({ "chain.test": [["127.0.0.1"]] });
    handler = (req, res) => {
      const step = Number(req.url?.slice(1) ?? "0");
      if (step < 4) res.writeHead(302, { location: `/${step + 1}` }).end();
      else res.end("done");
    };
    const policy = policyOf(["127.0.0.0/8"], dns.lookup);
    const reached = await egressFetch({ url: `http://chain.test:${port}/1` }, policy);
    expect(reached.status).toBe(200);
    const failure = await refusal(egressFetch({ url: `http://chain.test:${port}/0` }, policy));
    expect(failure.class).toBe("too_many_redirects");
  });
});

const local = () => stubLookup({ "slow.test": [["127.0.0.1"]] });

describe("egressFetch size and total time", () => {
  it("a response above the size cap is cut as size_exceeded", async () => {
    handler = (_req, res) => {
      res.write("x".repeat(600));
      setTimeout(() => res.end("y".repeat(600)), 20);
    };
    const failure = await refusal(
      egressFetch(
        { url: `http://slow.test:${port}/`, maxBytes: 1000 },
        policyOf(["127.0.0.0/8"], local().lookup),
      ),
    );
    expect(failure.class).toBe("size_exceeded");
  });

  it("a HEAD answer with a large content-length is not a size_exceeded", async () => {
    handler = (_req, res) => res.writeHead(200, { "content-length": "5000" }).end();
    const reply = await egressFetch(
      { url: `http://slow.test:${port}/`, method: "HEAD", maxBytes: 1000 },
      policyOf(["127.0.0.0/8"], local().lookup),
    );
    expect(reply.status).toBe(200);
  });

  it("one time limit bounds the whole call, redirects included", async () => {
    handler = (_req, res) => {
      setTimeout(() => res.writeHead(302, { location: "/next" }).end(), 250);
    };
    const failure = await refusal(
      egressFetch(
        { url: `http://slow.test:${port}/`, timeoutMs: 600 },
        policyOf(["127.0.0.0/8"], local().lookup),
      ),
    );
    expect(failure.class).toBe("timeout");
  });
});

describe("egressFetch caller's signal", () => {
  it("a signal that aborts ends a sent call at once, as a possible effect, long before its own time limit", async () => {
    handler = () => undefined;
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 150);
    const began = Date.now();
    const failure = await refusal(
      egressFetch(
        {
          url: `http://slow.test:${port}/`,
          method: "POST",
          body: "payload",
          timeoutMs: 5_000,
          signal: caller.signal,
        },
        policyOf(["127.0.0.0/8"], local().lookup),
      ),
    );
    expect([failure.class, failure.effect]).toEqual(["network", "possible"]);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("a signal that is already aborted refuses the call before any connection is opened", async () => {
    const caller = new AbortController();
    caller.abort();
    await refusal(
      egressFetch(
        { url: `http://slow.test:${port}/`, timeoutMs: 5_000, signal: caller.signal },
        policyOf(["127.0.0.0/8"], local().lookup),
      ),
    );
    expect(connections).toBe(0);
  });
});

describe("egressFetch first hop headers", () => {
  it.each([
    ["host", "evil.test"],
    ["Host", "evil.test"],
    ["content-length", "1"],
    ["Content-Length", "1"],
    ["transfer-encoding", "chunked"],
    ["Transfer-Encoding", "chunked"],
  ])("a caller's %s header is not sent on the first hop", async (name, value) => {
    const seen: { host: string | undefined; length: string | undefined; body: string }[] = [];
    handler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          host: req.headers.host,
          length: req.headers["content-length"],
          body: Buffer.concat(chunks).toString(),
        });
        res.end("ok");
      });
    };
    const reply = await egressFetch(
      { url: `http://slow.test:${port}/`, method: "POST", body: "payload", headers: { [name]: value } },
      policyOf(["127.0.0.0/8"], local().lookup),
    );
    expect(reply.status).toBe(200);
    expect(seen).toEqual([{ host: `slow.test:${port}`, length: "7", body: "payload" }]);
  });
});

describe("egressFetch connections and retry", () => {
  it("keep-alive reuses one connection per host", async () => {
    const policy = policyOf(["127.0.0.0/8"], local().lookup);
    await egressFetch({ url: `http://slow.test:${port}/a` }, policy);
    // undici frees the socket a moment after the body ends; a request issued in that instant opens a second one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await egressFetch({ url: `http://slow.test:${port}/b` }, policy);
    expect(connections).toBe(1);
  });

  it("a connect timeout is retried once before anything is sent", async () => {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
      return [{ address: "127.0.0.1", family: 4 as const }];
    };
    const reply = await egressFetch(
      { url: `http://slow.test:${port}/`, connectTimeoutMs: 100 },
      policyOf(["127.0.0.0/8"], lookup),
    );
    expect(reply.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("a connect timeout that persists reports effect none", async () => {
    const lookup = () => new Promise<never>(() => undefined);
    const failure = await refusal(
      egressFetch(
        { url: `http://slow.test:${port}/`, connectTimeoutMs: 80 },
        policyOf(["127.0.0.0/8"], lookup),
      ),
    );
    expect([failure.class, failure.effect]).toEqual(["connect_timeout", "none"]);
  });
});

describe("egressFetch connect timer", () => {
  // The connect timer is held below the total one, so a lookup that hangs ends as a connect timeout and not as a
  // timeout that could have sent something.
  it.each([
    ["no connect timeout is given", undefined, 2_500],
    ["the total timeout is below the connect timeout", 4_000, 2_000],
  ])(
    "a lookup that never answers ends as connect_timeout with no effect when %s",
    async (_name, connect, total) => {
      const lookup = () => new Promise<never>(() => undefined);
      const began = Date.now();
      const failure = await refusal(
        egressFetch(
          {
            url: `http://slow.test:${port}/`,
            ...(connect === undefined ? {} : { connectTimeoutMs: connect }),
            timeoutMs: total,
          },
          policyOf(["127.0.0.0/8"], lookup),
        ),
      );
      expect([failure.class, failure.effect]).toEqual(["connect_timeout", "none"]);
      expect(Date.now() - began).toBeLessThan(total);
    },
  );
});

describe("egressFetch send timeout", () => {
  it("a timeout after the request was sent reports effect possible", async () => {
    handler = () => undefined;
    const failure = await refusal(
      egressFetch(
        { url: `http://slow.test:${port}/`, method: "POST", body: "payload", timeoutMs: 200 },
        policyOf(["127.0.0.0/8"], local().lookup),
      ),
    );
    expect([failure.class, failure.effect]).toEqual(["timeout", "possible"]);
  });
});

// A provider whose accounts live on user-chosen servers is bound to the one host its channel stored: an instance that
// answers a redirect to another host is refused without following it, so the token is never sent there.
describe("egressFetch bound to an instance host", () => {
  it("refuses a redirect to another host, and the other host is never asked", async () => {
    const dns = stubLookup({ "a.test": [["127.0.0.1"]], "b.test": [["127.0.0.1"]] });
    const seen: string[] = [];
    handler = (req, res) => {
      seen.push(`${req.headers.host}:${req.headers.authorization ?? "none"}`);
      res.writeHead(302, { location: `http://b.test:${port}/` }).end();
    };
    const policy = {
      request: { kind: "instance", host: "a.test" } as const,
      operator: createOperatorPolicy({
        allowCidrs: ["127.0.0.0/8"],
        ports: [port],
        schemes: ["http:"],
        lookup: dns.lookup,
      }),
    };
    const headers = { authorization: "Bearer instance-token-1" };
    const failure = await refusal(egressFetch({ url: `http://a.test:${port}/`, headers }, policy));
    expect(failure.class).toBe("host_not_allowed");
    expect(seen).toEqual([`a.test:${port}:Bearer instance-token-1`]);
    expect(dns.calls["b.test"]).toBeUndefined();
  });
});
