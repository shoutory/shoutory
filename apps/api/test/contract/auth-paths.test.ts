import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { AUTH_BASE, AUTH_PATHS, DISABLED_PATHS } from "../../src/auth/paths.js";
import { createLogger } from "../../src/logging/logger.js";
import { testAuth } from "../support/auth.js";

describe("the paths of the pinned Better-Auth", () => {
  const pool = createAppPool("postgres://shoutory_auth:auth-test-secret-1@127.0.0.1:1/none", () => undefined);
  const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
  const keys = new EnvKeyProvider({
    SHOUTORY_ACTIVE_KEY_ID: "k1",
    SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
  });
  const auth = testAuth(pool, keys, logger, "https://app.example.test");
  // An endpoint with no path is server-only: the router never serves it.
  const exposed = Object.values(auth.library.api as Record<string, { path?: string }>)
    .map((endpoint) => endpoint.path)
    .filter((path): path is string => typeof path === "string");
  const forwarded = new Set(AUTH_PATHS.filter((row) => !row.ours).map((row) => row.path));

  it("every path it exposes is a forwarded mount row or in DISABLED_PATHS, and never both", () => {
    expect(exposed.length).toBeGreaterThan(10);
    for (const path of exposed) {
      const mounted = forwarded.has(`${AUTH_BASE}${path}`);
      const disabled = DISABLED_PATHS.includes(path);
      expect(mounted !== disabled, `${path}: mounted ${mounted}, disabled ${disabled}`).toBe(true);
    }
  });

  it("every disabled path and every forwarded row still exists in the pinned library", () => {
    for (const path of DISABLED_PATHS) expect(exposed, path).toContain(path);
    for (const path of forwarded) expect(exposed, path).toContain(path.slice(AUTH_BASE.length));
  });
});
