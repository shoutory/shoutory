import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/app.js";
import { Refusal } from "../../src/errors/refusal.js";
import { createLogger } from "../../src/logging/logger.js";
import { defineRoute } from "../../src/routes/define-route.js";
import { testAuth } from "../support/auth.js";

const CANARY = 'http-canary"v\\1/a b+c=d';
const spellings = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY).toString("hex"),
  Buffer.from(CANARY).toString("base64"),
  JSON.stringify(CANARY).slice(1, -1),
];
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", "x-shoutory-client": "web" };
const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };

function build() {
  const logged: string[] = [];
  const logger = createLogger({ secrets: [CANARY], stream: { write: (line) => void logged.push(line) } });
  // The canary is also the password of the pool's connection string, so a pool error carries it.
  const pool = createAppPool(
    `postgres://shoutory_app:${encodeURIComponent(CANARY)}@127.0.0.1:1/none`,
    () => undefined,
  );
  const keys = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  });
  const auth = testAuth(pool, keys, logger, "https://app.example.test");
  const app = createApp({
    publicOrigin: "https://app.example.test",
    trustedProxies: [],
    pool,
    keys,
    logger,
    auth,
  });
  const route = (path: string, handler: () => unknown) =>
    defineRoute(app, {
      method: "get",
      path,
      policy: "public",
      access: "none",
      handler: handler as () => never,
    });
  route("/test/throws-error", () => {
    throw new Error(`failed for ${CANARY}`);
  });
  route("/test/throws-refusal", () => {
    throw new Refusal("validation_failed", `bad ${CANARY}`, { cause: new Error(CANARY) });
  });
  route("/test/throws-cause", () => {
    throw new Error("outer", { cause: new Error(CANARY) });
  });
  route("/test/pool", () => pool.query("SELECT 1"));
  defineRoute(app, {
    method: "post",
    path: "/test/body",
    policy: "public",
    access: "none",
    body: z.strictObject({ name: z.string().max(5) }),
    handler: () => ({ ok: true }),
  });
  return { app, logged };
}

const send = (app: ReturnType<typeof build>["app"], path: string, init?: RequestInit) =>
  Promise.resolve(app.request(path, init, REMOTE));

const post = (body: string): RequestInit => ({
  method: "POST",
  headers: { ...SAME_ORIGIN, "content-type": "application/json" },
  body,
});

// The exact status each surface must answer, so a row cannot pass by failing in the wrong way.
const STATUS: Record<string, number> = {
  "an error message": 500,
  "a refusal message and cause": 400,
  "an error cause": 500,
  "a pool error carrying the connection string": 503,
  "a URL path": 404,
  "a URL query": 400,
  "an unknown body key": 400,
  "a rejected body value": 400,
  "malformed JSON containing it": 400,
  "a request cookie and header": 500,
};

describe("a planted canary never leaves the process", () => {
  it.each([
    ["an error message", (app: ReturnType<typeof build>["app"]) => send(app, "/test/throws-error")],
    [
      "a refusal message and cause",
      (app: ReturnType<typeof build>["app"]) => send(app, "/test/throws-refusal"),
    ],
    ["an error cause", (app: ReturnType<typeof build>["app"]) => send(app, "/test/throws-cause")],
    [
      "a pool error carrying the connection string",
      (app: ReturnType<typeof build>["app"]) => send(app, "/test/pool"),
    ],
    ["a URL path", (app: ReturnType<typeof build>["app"]) => send(app, `/${encodeURIComponent(CANARY)}`)],
    [
      "a URL query",
      (app: ReturnType<typeof build>["app"]) =>
        send(app, `/test/throws-error?q=${encodeURIComponent(CANARY)}`),
    ],
    [
      "an unknown body key",
      (app: ReturnType<typeof build>["app"]) =>
        send(app, "/test/body", post(JSON.stringify({ [CANARY]: 1 }))),
    ],
    [
      "a rejected body value",
      (app: ReturnType<typeof build>["app"]) =>
        send(app, "/test/body", post(JSON.stringify({ name: CANARY }))),
    ],
    [
      "malformed JSON containing it",
      (app: ReturnType<typeof build>["app"]) => send(app, "/test/body", post(`{"name": ${CANARY}`)),
    ],
    [
      "a request cookie and header",
      (app: ReturnType<typeof build>["app"]) =>
        send(app, "/test/throws-error", { headers: { cookie: `session=${CANARY}`, "x-custom": CANARY } }),
    ],
  ])("is absent from every response surface and every log line: %s", async (name, act) => {
    const { app, logged } = build();
    const response = await act(app);
    const surfaces = [
      await response.text(),
      response.headers.getSetCookie().join("\n"),
      [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"),
      logged.join(""),
    ];
    for (const surface of surfaces) {
      for (const spelling of spellings) expect(surface).not.toContain(spelling);
    }
    expect(response.status).toBe(STATUS[name]);
  });
});

describe("an invitation link carried through sign-in", () => {
  // The link rides in `return-to`; this value is not a registered secret, so only the URL redaction itself can keep
  // it out of the request log.
  it("an invitation link in a return-to query is logged without its token", async () => {
    const { app, logged } = build();
    const token = "invitetoken-return-to-sample-0001-aaaaa";
    const response = await send(app, `/sign-in?return-to=${encodeURIComponent(`/invite/${token}`)}`);
    expect(response.status).toBe(404);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("")).not.toContain(token);
  });
});
