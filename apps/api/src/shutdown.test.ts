import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, closeTogether, drain, firstOnly } from "./shutdown.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections();
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  // `arrived` settles when a request has reached the handler, so the signal never races the request on the wire.
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const server = createServer((request, response) => {
    arrive();
    handler(request, response);
  });
  servers.push(server);
  const url = `http://127.0.0.1:${await listenLoopback(server)}/`;
  // The process's own close: the server stops accepting and waits for the requests in flight.
  return { url, arrived, close: () => closeServer(server) };
}

describe("draining on SIGTERM", () => {
  // The floor: a write that is in flight when the signal arrives finishes before the process exits, and nothing new
  // is accepted once the stop began.
  it("lets a request in flight finish and refuses a new connection, then reports a clean exit", async () => {
    const { url, arrived, close } = await listen((_request, response) => {
      setTimeout(() => response.end("written"), 300);
    });
    const inFlight = fetch(url).then((answer) => answer.text());
    await arrived;
    const draining = drain(close, { timeoutMs: 2_000 });
    await expect(fetch(url)).rejects.toThrow();
    const outcome = await draining;
    expect(await inFlight).toBe("written");
    expect(outcome).toEqual({ code: 0 });
  });
});

describe("the bound and the parts of a stop", () => {
  it("stops the server and the worker together, and still stops the other when one fails", async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = async () => {
      started.push("server");
      await slow;
    };
    const worker = () => {
      started.push("worker");
      return Promise.reject(new Error("worker did not stop"));
    };
    const closing = closeTogether([server, worker]);
    expect(started).toEqual(["server", "worker"]);
    release();
    await expect(closing).rejects.toThrow();
    const finished: string[] = [];
    const first = () => Promise.reject(new Error("first failed"));
    const second = async () => {
      finished.push("second");
    };
    await expect(closeTogether([first, second])).rejects.toThrow();
    expect(finished).toEqual(["second"]);
  });

  it("starts one drain however many signals arrive", () => {
    let drains = 0;
    const onSignal = firstOnly(() => {
      drains += 1;
    });
    onSignal();
    onSignal();
    expect(drains).toBe(1);
  });

  it("cuts a request that never ends at the bound and reports a failed exit", async () => {
    const { url, arrived, close } = await listen(() => undefined);
    const hung = fetch(url).catch(() => undefined);
    await arrived;
    const started = Date.now();
    const outcome = await drain(close, { timeoutMs: 200 });
    expect(outcome).toEqual({ code: 1, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const server of servers) server.closeAllConnections();
    await hung;
  });

  it("reports a failed exit, with no error text, when the close itself throws", async () => {
    const outcome = await drain(() => Promise.reject(new Error("postgres://user:secret@host/db refused")), {
      timeoutMs: 2_000,
    });
    expect(outcome).toEqual({ code: 1, reason: "failed" });
  });
});
