import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool } from "@shoutory/db/pool";
import { describe, expect, it } from "vitest";
import { testAuth } from "../../test/support/auth.js";
import { createLogger } from "../logging/logger.js";

describe("the library's log lines", () => {
  it("keep their level, and nothing below warn is logged", async () => {
    const lines: string[] = [];
    const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
    const pool = createAppPool(
      "postgres://shoutory_auth:auth-test-secret-1@127.0.0.1:1/none",
      () => undefined,
    );
    const keys = new EnvKeyProvider({
      SHOUTORY_ACTIVE_KEY_ID: "k1",
      SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
    });
    const library = testAuth(pool, keys, logger, "https://app.example.test").library;
    const { logger: libraryLogger } = await library.$context;
    libraryLogger.info("an info line with someone@example.test");
    libraryLogger.warn("a warn line");
    libraryLogger.error("an error line");
    const levels = lines.map((line) => (JSON.parse(line) as { level: string; msg: string }).level);
    expect(levels).toEqual(["warn", "error"]);
    // One level key per line: a forwarded field must not shadow the logger's own.
    for (const line of lines) expect(line.match(/"level":/g)).toHaveLength(1);
    expect(lines.join("")).not.toContain("someone@example.test");
    await pool.end();
  });
});
