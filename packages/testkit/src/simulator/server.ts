import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { createFaultQueue, type Fault, type FaultQueue } from "./faults.js";

interface SimRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface SimReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface SimContext {
  /** Counts one effect at the provider (a post created, edited or deleted). */
  effect(): void;
}

export type Handler = (request: SimRequest, context: SimContext) => SimReply | Promise<SimReply>;

export interface Simulator {
  readonly url: string;
  readonly faults: FaultQueue;
  /** Every request the simulator received, raw, for assertions; never written to disk (the scrubber does that). */
  readonly requests: readonly SimRequest[];
  /** How many effects the handlers produced; a late effect counts once it has happened. */
  effects(): number;
  /** Waits for effects that were scheduled to appear late. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

const MAX_RECORDED_REQUESTS = 1000;
const MAX_BODY_BYTES = 1_048_576;

// The whole body, or undefined when it is over the bound.
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

type Routes = Readonly<Record<string, Handler>>;

interface State {
  readonly routes: Routes;
  readonly faults: FaultQueue;
  readonly requests: SimRequest[];
  readonly late: Set<Promise<unknown>>;
  readonly timers: Set<NodeJS.Timeout>;
  readonly context: SimContext;
  readonly before: ((route: string) => void | Promise<void>) | undefined;
  effects: number;
}

export interface SimulatorOptions {
  /** Runs when a request has been received, before an armed fault or the route's handler (so before any effect). */
  readonly before?: (route: string) => void | Promise<void>;
}

// A route is "METHOD /path", where a path segment `:name` matches any one segment and is passed as a param.
function matchRoute(routes: Routes, method: string, path: string) {
  const wanted = path.split("/");
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, pattern = ""] = key.split(" ");
    const segments = pattern.split("/");
    if (routeMethod !== method || segments.length !== wanted.length) continue;
    const params: Record<string, string> = {};
    const fits = segments.every((segment, index) => {
      const actual = wanted[index] ?? "";
      if (!segment.startsWith(":")) return segment === actual;
      params[segment.slice(1)] = decodeURIComponent(actual);
      return true;
    });
    if (fits) return { key, handler, params };
  }
  return undefined;
}

function send(response: ServerResponse, reply: SimReply): void {
  const raw = typeof reply.body === "string";
  response.writeHead(reply.status, {
    ...(reply.body === undefined || raw ? {} : { "content-type": "application/json" }),
    ...reply.headers,
  });
  const text = raw ? (reply.body as string) : JSON.stringify(reply.body);
  response.end(reply.body === undefined ? undefined : text);
}

function plainHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  );
}

function scheduleLateEffect(state: State, run: () => Promise<SimReply>, delayMs: number): void {
  const effect = new Promise<void>((resolve) => {
    state.timers.add(setTimeout(() => void run().then(() => resolve()), delayMs));
  });
  state.late.add(effect);
}

async function applyFault(
  state: State,
  fault: Fault,
  run: () => Promise<SimReply>,
  response: ServerResponse,
): Promise<void> {
  if (fault.kind === "hang") {
    if (fault.effectDelayMs !== undefined) scheduleLateEffect(state, run, fault.effectDelayMs);
    return;
  }
  if (fault.kind === "truncate" || (fault.kind === "respond" && fault.afterEffect === true)) await run();
  if (fault.kind === "respond") send(response, fault);
  if (fault.kind === "truncate") {
    response.writeHead(200, { "content-length": 100 });
    response.write("{");
    response.socket?.destroy();
  }
}

async function handle(state: State, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://simulator.invalid");
  const method = request.method ?? "GET";
  const route = matchRoute(state.routes, method, url.pathname);
  if (!route) return send(response, { status: 404, body: { error: "no such route" } });
  const body = await readBody(request);
  if (body === undefined) return send(response, { status: 413, body: { error: "body too large" } });
  const seen: SimRequest = {
    method,
    path: url.pathname,
    params: route.params,
    query: url.searchParams,
    headers: plainHeaders(request),
    body,
  };
  state.requests.push(seen);
  if (state.requests.length > MAX_RECORDED_REQUESTS) state.requests.shift();
  await state.before?.(route.key);
  const run = async () => route.handler(seen, state.context);
  const fault = state.faults.take(route.key);
  if (fault) return applyFault(state, fault, run, response);
  send(response, await run());
}

/** Starts a loopback HTTP server that answers the routes, applies armed faults and records what it received. */
export async function startSimulator(routes: Routes, options: SimulatorOptions = {}): Promise<Simulator> {
  const state: State = {
    routes,
    before: options.before,
    faults: createFaultQueue(),
    requests: [],
    late: new Set(),
    timers: new Set(),
    context: {
      effect: () => {
        state.effects += 1;
      },
    },
    effects: 0,
  };
  const server = createServer((request, response) => {
    handle(state, request, response).catch(() => response.socket?.destroy());
  });
  const port = await listenLoopback(server);
  return {
    url: `http://127.0.0.1:${port}`,
    faults: state.faults,
    requests: state.requests,
    effects: () => state.effects,
    settle: async () => {
      await Promise.all([...state.late]);
    },
    close: async () => {
      for (const timer of state.timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
