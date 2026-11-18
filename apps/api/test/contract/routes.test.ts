import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { registeredRoutes } from "../../src/routes/define-route.js";
import { registerStatic } from "../../src/static/static.js";

const POLICIES = ["public"];

describe("route registration", () => {
  it("every route of the app is registered through defineRoute with a policy", () => {
    const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
    const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
    const app = createApp({
      publicOrigin: "https://app.example.test",
      trustedProxies: [],
      pool,
      keys: new EnvKeyProvider({
        SHOUTORY_ACTIVE_KEY_ID: "k1",
        SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
      }),
      logger,
    });
    registerStatic(app, ".");
    const registered = registeredRoutes(app);
    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const route of registered) expect(POLICIES, `${route.method} ${route.path}`).toContain(route.policy);
    // Exactly one route may opt out of the strict query schema: the SPA shell route (R50).
    expect(
      registered.filter((route) => route.looseQuery).map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET /*"]);
    // A route added straight to the Hono instance is visible in app.routes but not in the registry.
    const handlers = app.routes.filter((route) => route.method !== "ALL");
    const keys = new Set(registered.map((route) => `${route.method} ${route.path}`));
    for (const route of handlers)
      expect(keys, `${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`);
  });
});
