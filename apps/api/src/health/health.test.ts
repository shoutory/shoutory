import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { describe, expect, it, vi } from "vitest";
import { testAuth } from "../../test/support/auth.js";
import { createApp } from "../app.js";
import { createLogger } from "../logging/logger.js";

// The shipped migration list is read from disk once; the first read fails and the second succeeds.
const loadMigrations = vi.hoisted(() => vi.fn());
vi.mock("@shoutory/db/migrate", () => ({ loadMigrations }));

const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };

describe("/readyz and a failed read of the shipped migration list", () => {
  it("answers an error for the failed probe and is ready on the next one", async () => {
    loadMigrations.mockRejectedValueOnce(new Error("folder unreadable")).mockResolvedValue([]);
    // Nothing is applied and nothing is shipped, and no sealed row holds a key; the three job definers answer healthy.
    const answers: [string, object[]][] = [
      ["app.outbox_lag", [{ lag: 0 }]],
      ["app.worker_status", [{ stale: false }]],
      ["app.job_lag", [{ installed: true, lag_seconds: 0 }]],
    ];
    const pool = {
      query: async (sql: string) => ({ rows: answers.find(([name]) => sql.includes(name))?.[1] ?? [] }),
    } as unknown as AppPool;
    const keys = new EnvKeyProvider({
      SHOUTORY_ACTIVE_KEY_ID: "k1",
      SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
    });
    const logger = createLogger({ secrets: [], stream: { write: () => undefined } });
    const publicOrigin = "https://app.example.test";
    const app = createApp({
      publicOrigin,
      trustedProxies: [],
      pool,
      keys,
      logger,
      auth: testAuth(pool, keys, logger, publicOrigin),
    });
    expect((await Promise.resolve(app.request("/readyz", {}, REMOTE))).status).toBe(500);
    expect((await Promise.resolve(app.request("/readyz", {}, REMOTE))).status).toBe(200);
  });
});
