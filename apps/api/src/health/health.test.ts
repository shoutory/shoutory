import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createLogger } from "../logging/logger.js";

// The shipped migration list is read from disk once; the first read fails and the second succeeds.
const loadMigrations = vi.hoisted(() => vi.fn());
vi.mock("@shoutory/db/migrate", () => ({ loadMigrations }));

const REMOTE = { incoming: { socket: { remoteAddress: "192.0.2.1" } } };

describe("/readyz and a failed read of the shipped migration list", () => {
  it("answers an error for the failed probe and is ready on the next one", async () => {
    loadMigrations.mockRejectedValueOnce(new Error("folder unreadable")).mockResolvedValue([]);
    // Nothing is applied and nothing is shipped, and no sealed row holds a key.
    const pool = { query: async () => ({ rows: [] }) } as unknown as AppPool;
    const app = createApp({
      publicOrigin: "https://app.example.test",
      trustedProxies: [],
      pool,
      keys: new EnvKeyProvider({
        SHOUTORY_ACTIVE_KEY_ID: "k1",
        SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
      }),
      logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
    });
    expect((await Promise.resolve(app.request("/readyz", {}, REMOTE))).status).toBe(500);
    expect((await Promise.resolve(app.request("/readyz", {}, REMOTE))).status).toBe(200);
  });
});
