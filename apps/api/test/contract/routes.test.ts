import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { type AppOptions, createApp } from "../../src/app.js";
import { createLogger } from "../../src/logging/logger.js";
import { registeredRoutes } from "../../src/routes/define-route.js";
import { registerStatic } from "../../src/static/static.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { testAuth } from "../support/auth.js";

const POLICIES = ["public", "session", "step_up"];

function buildApp(extra: Partial<AppOptions> = {}) {
  const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
  const pool = createAppPool("postgres://shoutory_app:app-test-secret-1@127.0.0.1:1/none", () => undefined);
  const ring = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  });
  const publicOrigin = "https://app.example.test";
  return createApp({
    publicOrigin,
    trustedProxies: [],
    pool,
    keys: ring,
    logger,
    auth: testAuth(pool, ring, logger, publicOrigin),
    ...extra,
  });
}

describe("route registration", () => {
  it("every route of the app is registered through defineRoute with a policy", () => {
    const app = buildApp();
    registerStatic(app, ".");
    const registered = registeredRoutes(app);
    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const route of registered) expect(POLICIES, `${route.method} ${route.path}`).toContain(route.policy);
    // Only the SPA shell route may opt out of the strict query schema.
    expect(
      registered.filter((route) => route.looseQuery).map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET /*"]);
    // A route added straight to the Hono instance is visible in app.routes but not in the registry.
    const handlers = app.routes.filter((route) => route.method !== "ALL");
    const keys = new Set(registered.map((route) => `${route.method} ${route.path}`));
    for (const route of handlers)
      expect(keys, `${route.method} ${route.path}`).toContain(`${route.method} ${route.path}`);
  });

  it("the media routes are session routes with a library permission; the PUT exists only without a presigner", () => {
    const storage = createFsDriver(".");
    const signed = async () => ({ url: "", headers: {} });
    const presigner = { presignPut: signed, presignPart: signed };
    const mediaOf = (app: ReturnType<typeof createApp>) =>
      registeredRoutes(app)
        .filter((route) => route.path.includes("/media"))
        .map(
          (route) =>
            `${route.method} ${route.policy} ${(route.access as { permission?: string }).permission}`,
        );
    const read = "GET session library.view";
    const edit = "session library.edit";
    // The library: list, one medium, a derivative, metadata and delete.
    const library = [read, read, read, `PATCH ${edit}`, `DELETE ${edit}`];
    expect(mediaOf(buildApp({ storage }))).toEqual([
      `POST ${edit}`,
      `POST ${edit}`,
      `POST ${edit}`,
      `PUT ${edit}`,
      `PUT ${edit}`,
      read,
      ...library,
    ]);
    expect(mediaOf(buildApp({ storage, presigner }))).toEqual([
      `POST ${edit}`,
      `POST ${edit}`,
      read,
      ...library,
    ]);
    // The part-signing route exists only where storage can run multipart uploads.
    const multipart = {} as never;
    expect(mediaOf(buildApp({ storage, presigner, multipart }))).toEqual([
      `POST ${edit}`,
      `POST ${edit}`,
      `POST ${edit}`,
      read,
      ...library,
    ]);
  });
});
