import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testAuth } from "../test/support/auth.js";
import { createApp } from "./app.js";
import { Refusal } from "./errors/refusal.js";
import { createLogger } from "./logging/logger.js";
import { defineRoute } from "./routes/define-route.js";

const testKeys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

const ORIGIN = "https://app.example.test";
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "x-shoutory-client": "web" };
const MIB = 1024 * 1024;

interface Harness {
  app: ReturnType<typeof createApp>;
  calls: () => number;
  lines: string[];
  send(path: string, init?: RequestInit, peer?: string): Promise<Response>;
}

/** Routes whose handlers throw one prepared error each. */
function addThrowers(app: ReturnType<typeof createApp>): void {
  const thrower = (path: string, error: unknown) =>
    defineRoute(app, {
      method: "get",
      path,
      policy: "public",
      access: "none",
      handler: () => {
        throw error;
      },
    });
  thrower("/test/unknown-error", new Error("db password hunter2-detail at /srv/app/secret.ts"));
  for (const code of ["not_found", "csrf_rejected", "validation_failed", "service_unavailable"] as const) {
    thrower(`/test/refusal/${code}`, new Refusal(code, "refused on purpose"));
  }
  for (const [name, pgCode] of [
    ["connection-refused", "ECONNREFUSED"],
    ["admin-shutdown", "57P01"],
    ["crash-shutdown", "57P02"],
    ["cannot-connect-now", "57P03"],
    ["connection-exception", "08006"],
    ["unique-violation", "23505"],
  ] as const) {
    thrower(`/test/pg/${name}`, Object.assign(new Error(`pg ${pgCode}`), { code: pgCode }));
  }
  thrower("/test/pg/connect-timeout", new Error("timeout exceeded when trying to connect"));
}

function build(trustedProxies: string[] = []): Harness {
  const lines: string[] = [];
  const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
  // A pool that is never asked for a connection; the unreachable port makes any use fail loudly.
  const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
  const auth = testAuth(pool, testKeys, logger, ORIGIN);
  const app = createApp({ publicOrigin: ORIGIN, trustedProxies, pool, keys: testKeys, logger, auth });
  let calls = 0;
  defineRoute(app, {
    method: "post",
    path: "/test/echo",
    policy: "public",
    access: "none",
    body: z.strictObject({ name: z.string().max(20) }),
    handler: ({ body }) => {
      calls += 1;
      return { echoed: body.name };
    },
  });
  defineRoute(app, {
    method: "get",
    path: "/test/items",
    policy: "public",
    access: "none",
    query: z.strictObject({ limit: z.coerce.number().int().max(100).optional() }),
    handler: () => {
      calls += 1;
      return { items: [] };
    },
  });
  defineRoute(app, {
    method: "post",
    path: "/test/created",
    policy: "public",
    access: "none",
    status: 201,
    body: z.strictObject({ name: z.string().max(20) }),
    handler: ({ body }) => ({ made: body.name }),
  });
  defineRoute(app, {
    method: "get",
    path: "/test/who",
    policy: "public",
    access: "none",
    handler: ({ clientAddress }) => ({ clientAddress }),
  });
  addThrowers(app);
  return {
    app,
    calls: () => calls,
    lines,
    send: (path, init, peer = "192.0.2.1") =>
      Promise.resolve(app.request(path, init, { incoming: { socket: { remoteAddress: peer } } })),
  };
}

const post = (
  body: NonNullable<RequestInit["body"]> | null,
  headers: Record<string, string> = {},
): RequestInit => ({
  method: "POST",
  headers: { ...SAME_ORIGIN, ...headers },
  body,
});
const json = (value: unknown) => post(JSON.stringify(value), { "content-type": "application/json" });

async function envelope(response: Response): Promise<{ code: string; message: string; requestId: string }> {
  const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
  return body.error;
}

describe("the error envelope", () => {
  it.each([
    ["not_found", 404],
    ["csrf_rejected", 403],
    ["validation_failed", 400],
    ["service_unavailable", 503],
  ])("a thrown %s refusal answers %i with the envelope and its request id", async (code, status) => {
    const { send } = build();
    const response = await send(`/test/refusal/${code}`);
    expect(response.status).toBe(status);
    const error = await envelope(response);
    expect(error.code).toBe(code);
    expect(error.requestId).toBe(response.headers.get("x-request-id"));
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
  });

  it("an unknown error answers 500 with no detail, no stack and a request id", async () => {
    const { send, lines } = build();
    const response = await send("/test/unknown-error");
    expect(response.status).toBe(500);
    const text = await response.clone().text();
    expect((await envelope(response)).code).toBe("internal_error");
    expect(text).not.toMatch(/hunter2|\/srv\/app|secret\.ts|\bat\b.*\.ts|stack/);
    // The operator still gets the cause, scrubbed, in the log.
    expect(lines.join("")).toContain("internal_error");
  });

  it.each([
    ["a refused connection", "connection-refused", 503],
    ["admin shutdown", "admin-shutdown", 503],
    ["crash shutdown", "crash-shutdown", 503],
    ["cannot connect now", "cannot-connect-now", 503],
    ["a connection exception class", "connection-exception", 503],
    ["a pool connect timeout", "connect-timeout", 503],
    ["an unrelated database error stays a 500", "unique-violation", 500],
  ])("%s answers %i", async (_name, route, status) => {
    const { send } = build();
    const response = await send(`/test/pg/${route}`);
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null);
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("every response carries a distinct X-Request-Id, errors and unregistered routes included", async () => {
    const { send } = build();
    const responses = [
      await send("/test/items"),
      await send("/test/unknown-error"),
      await send("/test/no-such-route"),
      await send("/test/echo", json({ name: "a", extra: 1 })),
    ];
    const ids = responses.map((r) => r.headers.get("x-request-id"));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("strict input before the handler", () => {
  it("accepts a valid body and answers the data envelope", async () => {
    const { send, calls } = build();
    const response = await send("/test/echo", json({ name: "ada" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { echoed: "ada" } });
    expect(calls()).toBe(1);
  });

  it("a route that declares status 201 answers 201 with the data envelope", async () => {
    const response = await build().send("/test/created", json({ name: "ada" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { made: "ada" } });
  });

  it.each([
    ["malformed JSON", '{"name":', 400, "validation_failed"],
    ["an unknown field", JSON.stringify({ name: "a", extra: 1 }), 400, "validation_failed"],
    ["a field of the wrong type", JSON.stringify({ name: 5 }), 400, "validation_failed"],
    ["a body over 1 MiB", JSON.stringify({ name: "a".repeat(MIB + 1) }), 413, "payload_too_large"],
  ])("%s answers %i before the handler runs", async (_name, body, status, code) => {
    const { send, calls } = build();
    const response = await send("/test/echo", post(body, { "content-type": "application/json" }));
    expect(response.status).toBe(status);
    expect((await envelope(response)).code).toBe(code);
    expect(calls()).toBe(0);
  });

  it("a chunked body over the limit answers 413 with the envelope and never runs the handler", async () => {
    const { send, calls } = build();
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 20) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const init = post(stream, { "content-type": "application/json" }) as RequestInit & { duplex: string };
    init.duplex = "half";
    const response = await send("/test/echo", init);
    expect(response.status).toBe(413);
    expect((await envelope(response)).code).toBe("payload_too_large");
    expect(calls()).toBe(0);
  });

  it("an unknown query key is refused and a known one passes", async () => {
    const { send, calls } = build();
    expect((await send("/test/items?limit=5")).status).toBe(200);
    const refused = await send("/test/items?limit=5&extra=1");
    expect(refused.status).toBe(400);
    expect((await envelope(refused)).code).toBe("validation_failed");
    expect(calls()).toBe(1);
  });
});

describe("validation answers", () => {
  it("a validation failure never serialises the Zod error", async () => {
    const { send } = build();
    for (const body of [{ name: "a", "zz-unknown-key": 1 }, { name: 5 }, {}]) {
      const text = await (await send("/test/echo", json(body))).text();
      expect(text).not.toMatch(/unrecognized_keys|ZodError|_zod|"issues"|"success"|invalid_type/);
      expect(JSON.parse(text).error.code).toBe("validation_failed");
    }
  });

  it.each([
    ["a text/plain body", () => post("{}", { "content-type": "text/plain" })],
    ["a body with no Content-Type", () => post(new TextEncoder().encode('{"name":"a"}'))],
  ])("%s answers 415 with the envelope and never runs the handler", async (_name, init) => {
    const { send, calls } = build();
    const response = await send("/test/echo", init());
    expect(response.status).toBe(415);
    expect((await envelope(response)).code).toBe("unsupported_media_type");
    expect(calls()).toBe(0);
  });

  it("a required body route with no body and no Content-Type answers 415 with the envelope, never skipped", async () => {
    const { send, calls } = build();
    const response = await send("/test/echo", post(null));
    expect(response.status).toBe(415);
    expect((await envelope(response)).code).toBe("unsupported_media_type");
    expect(calls()).toBe(0);
  });
});

describe("client address in the handler", () => {
  const forwarded = { "x-forwarded-for": "198.51.100.9, 10.0.0.2" };
  it("a listed proxy: the handler sees the client behind it", async () => {
    const { send } = build(["10.0.0.0/8"]);
    const response = await send("/test/who", { headers: forwarded }, "10.0.0.1");
    expect(await response.json()).toEqual({ data: { clientAddress: "198.51.100.9" } });
  });
});

describe("the request log", () => {
  it("carries the request id of the response, so a client report finds its line", async () => {
    const { send, lines } = build();
    const response = await send("/test/items");
    const logged = lines.map((line) => JSON.parse(line) as { msg: string; requestId?: string });
    expect(logged.find((line) => line.msg === "request")?.requestId).toBe(
      response.headers.get("x-request-id"),
    );
  });
});

describe("defineRoute access", () => {
  const params = z.strictObject({ workspace_id: z.uuid() });
  it.each([
    ["none on a session route", { policy: "session", access: "none" }],
    ["user on a public route", { policy: "public", access: "user" }],
    ["a value outside the list", { policy: "session", access: "admin" }],
    [
      "a workspace parameter that is not in params",
      { policy: "session", access: { workspace: "id" }, params },
    ],
    [
      "a permission outside the matrix",
      { policy: "session", access: { workspace: "workspace_id", permission: "x" }, params },
    ],
    [
      "a change with no permission",
      { policy: "session", access: { workspace: "workspace_id" }, params, method: "patch" },
    ],
  ])("refuses %s at registration", (_name, extra) => {
    const { app } = build();
    expect(() =>
      defineRoute(app, {
        method: "get",
        path: "/test/w/{workspace_id}",
        handler: () => 1,
        ...extra,
      } as never),
    ).toThrow(/defineRoute/);
  });
});

describe("defineRoute strictness", () => {
  const strict = z.strictObject({ a: z.string() });
  it.each([
    ["a body that strips unknown keys", { body: z.object({ a: z.string() }) }],
    ["a body that keeps unknown keys", { body: z.looseObject({}) }],
    ["a body with a catchall", { body: z.object({}).catchall(z.string()) }],
    ["a query that strips unknown keys", { query: z.object({}) }],
    ["a loose query without the opt-in", { query: z.looseObject({}) }],
    ["params that strip unknown keys", { params: z.object({ id: z.string() }), path: "/test/p/{id}" }],
  ])("refuses %s at registration", (_name, extra) => {
    const { app } = build();
    expect(() =>
      defineRoute(app, {
        method: "post",
        path: "/test/new",
        policy: "public",
        access: "none",
        handler: () => 1,
        ...extra,
      }),
    ).toThrow(/strict/);
  });

  it("accepts strict schemas and a loose query only with the explicit opt-in", () => {
    const { app } = build();
    expect(() =>
      defineRoute(app, {
        method: "post",
        path: "/test/ok",
        policy: "public",
        access: "none",
        body: strict,
        handler: () => 1,
      }),
    ).not.toThrow();
    expect(() =>
      defineRoute(app, {
        method: "get",
        path: "/test/loose",
        policy: "public",
        access: "none",
        query: z.looseObject({}),
        looseQuery: true,
        handler: () => 1,
      }),
    ).not.toThrow();
  });
});
