import { connect, createServer, type Server, type Socket } from "node:net";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { defineRoute, registeredRoutes } from "../../src/routes/define-route.js";
import { registerStatic } from "../../src/static/static.js";
import { testAuth } from "../support/auth.js";

const env = readTestEnv();
const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
const testKeys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

class Forwarder {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(
    private readonly target: URL,
    readonly port: number,
  ) {}
  start(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = connect(Number(this.target.port), this.target.hostname);
      this.sockets.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      for (const s of [client, upstream]) s.on("error", () => s.destroy());
    });
    return new Promise((resolve) => this.server?.listen(this.port, "127.0.0.1", resolve));
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listenLoopback(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A ready answer needs a worker that has beaten.
const beat = (database: TestDatabase) =>
  database.pool("worker").query("SELECT app.worker_heartbeat('http-test-worker', 'worker')");

let db: TestDatabase;
let owner: ReturnType<TestDatabase["pool"]>;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  owner = db.pool("owner");
  await beat(db);
});
afterAll(async () => {
  await db.drop();
});

const ORIGIN = "https://app.example.test";
const appFor = (url: string) => {
  const pool = createAppPool(url, () => undefined);
  return createApp({
    publicOrigin: ORIGIN,
    trustedProxies: [],
    pool,
    keys: testKeys,
    logger,
    auth: testAuth(pool, testKeys, logger, ORIGIN),
  });
};
const get = (app: ReturnType<typeof createApp>, path: string) =>
  Promise.resolve(app.request(path, {}, REMOTE));

describe("readiness and health", () => {
  it("N parallel /readyz probes share one probe of six database queries", async () => {
    const pool = createAppPool(db.url("app"), () => undefined);
    const query = vi.spyOn(pool, "query");
    const app = createApp({
      publicOrigin: ORIGIN,
      trustedProxies: [],
      pool,
      keys: testKeys,
      logger,
      auth: testAuth(pool, testKeys, logger, ORIGIN),
    });
    const responses = await Promise.all(Array.from({ length: 20 }, () => get(app, "/readyz")));
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    // Migrations applied, key ids held, partition runway, outbox lag, workers, job lag.
    expect(query).toHaveBeenCalledTimes(6);
    await pool.end();
  });

  it("/readyz answers 503 with Retry-After while PostgreSQL is unreachable and 200 once it is back; /healthz stays 200", async () => {
    const target = new URL(db.url("app"));
    const forwarder = new Forwarder(target, await freePort());
    const through = new URL(target);
    through.hostname = "127.0.0.1";
    through.port = String(forwarder.port);
    const app = appFor(through.toString());
    await forwarder.start();
    try {
      expect((await get(app, "/readyz")).status).toBe(200);
      await forwarder.stop();
      const down = await get(app, "/readyz");
      expect(down.status).toBe(503);
      expect(down.headers.get("retry-after")).toBe("5");
      const body = (await down.json()) as { error: { code: string } };
      expect(body.error.code).toBe("service_unavailable");
      expect((await get(app, "/healthz")).status).toBe(200);
      await forwarder.start();
      expect((await get(app, "/readyz")).status).toBe(200);
    } finally {
      await forwarder.stop();
    }
  });

  it("/readyz is not ready, with a 503 and Retry-After, when a shipped migration is not recorded", async () => {
    const app = appFor(db.url("app"));
    expect((await get(app, "/readyz")).status).toBe(200);
    await owner.query(
      "DELETE FROM app.schema_migrations WHERE name = (SELECT max(name) FROM app.schema_migrations)",
    );
    const response = await get(app, "/readyz");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });
});

describe("readiness and held key ids", () => {
  const KEK = (n: number) => Buffer.alloc(32, n).toString("base64");
  const ring = (...ids: string[]) =>
    new EnvKeyProvider({
      SHOUTORY_ACTIVE_KEY_ID: "k1",
      SHOUTORY_KEK_K1: KEK(1),
      ...Object.fromEntries(ids.map((keyId, i) => [`SHOUTORY_KEK_${keyId.toUpperCase()}`, KEK(i + 2)])),
    });
  let clone: TestDatabase;
  beforeAll(async () => {
    clone = await cloneTemplate(env, inject("shoutoryTemplate"));
    await beat(clone);
    await withAdminClient(env, clone.name, (admin) =>
      admin.query(
        `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
             link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
           VALUES (uuidv7(), 'held-1@example.test', 'verify_email', 'en', '{}', '\\x01', '\\x01', '\\x01', '\\x01', '\\x01',
             '\\x01', 'held', 1, 0, $1)`,
        ["d".repeat(64)],
      ),
    );
  });
  afterAll(() => clone.drop());

  const pools: ReturnType<typeof createAppPool>[] = [];
  const appWith = (keys: EnvKeyProvider, log = logger) => {
    const pool = createAppPool(clone.url("app"), () => undefined);
    pools.push(pool);
    const auth = testAuth(pool, keys, log, ORIGIN);
    return createApp({ publicOrigin: ORIGIN, trustedProxies: [], pool, logger: log, keys, auth });
  };
  afterAll(() => Promise.all(pools.map((pool) => pool.end())));

  it("/readyz answers 503 with Retry-After 5 when a sealed row names a key with no loaded key, and 200 again once loaded", async () => {
    const refused = await get(appWith(ring()), "/readyz");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await get(appWith(ring("held")), "/readyz")).status).toBe(200);
  });

  it("/readyz answers a bare 503 with no cause in the body, and the log line carries the cause", async () => {
    const lines: string[] = [];
    const sink = { write: (line: string) => void lines.push(line) };
    const refused = await get(appWith(ring(), createLogger({ secrets: [], stream: sink })), "/readyz");
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { error: { details?: unknown } };
    expect(body.error.details).toBeUndefined();
    expect(lines.join("\n")).toContain("key_missing");
  });
});

describe("failures and unknown routes", () => {
  it("a pool connection failure inside a route answers 503 with Retry-After and no connection detail", async () => {
    const dead = createAppPool(
      "postgres://shoutory_app:pool-test-secret-1@127.0.0.1:1/none",
      () => undefined,
    );
    const app = createApp({
      publicOrigin: ORIGIN,
      trustedProxies: [],
      pool: dead,
      keys: testKeys,
      logger,
      auth: testAuth(dead, testKeys, logger, ORIGIN),
    });
    defineRoute(app, {
      method: "get",
      path: "/test/db",
      policy: "public",
      access: "none",
      handler: async () => (await dead.query("SELECT 1")).rows,
    });
    const response = await get(app, "/test/db");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.text()).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|pool-test-secret-1/);
  });

  it("an unregistered route answers the 404 envelope with a request id", async () => {
    const app = appFor(db.url("app"));
    for (const [method, path] of [
      ["GET", "/nothing-here"],
      ["POST", "/api/v1/nothing-here"],
    ] as const) {
      const response = await Promise.resolve(app.request(path, { method }, REMOTE));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
    }
  });
});

describe("strict input", () => {
  it("strict input on every route: each registered route refuses an unknown query key", async () => {
    const app = appFor(db.url("app"));
    registerStatic(app, ".");
    const routes = registeredRoutes(app).filter((route) => route.method === "GET");
    expect(routes.length).toBeGreaterThanOrEqual(1);
    // The contract test proves the SPA shell route is the only one with a loose query; it is skipped here.
    for (const route of routes.filter((r) => !r.looseQuery)) {
      const response = await get(app, `${route.path}?zz-unknown-key=1`);
      expect(response.status, `${route.method} ${route.path}`).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    }
  });
});
