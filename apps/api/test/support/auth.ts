import { SealedSecret } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { type AppPool, createAuthDb } from "@shoutory/db/pool";
import { createAuth } from "../../src/auth/auth.js";
import type { Logger } from "../../src/logging/logger.js";

/** The authentication service over a pool, with fixed test secrets; for tests whose routes never read a session. */
export const testAuth = (pool: AppPool, keys: KeyProvider, logger: Logger, publicOrigin: string) =>
  createAuth({
    publicOrigin,
    secret: "session-secret-for-tests-0123456789abcdef",
    pepper: new SealedSecret("auth-pepper-for-tests-0123456789abcdef"),
    keys,
    db: createAuthDb(pool),
    pool,
    logger,
  });
