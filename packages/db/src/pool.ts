import { Pool } from "pg";

export type AppPool = Pool;

const MAX_CONNECTIONS = 10;
const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * The one pool of the API process for the `shoutory_app` role. Every wait is bounded: without a connect timeout
 * node-postgres waits forever, and an idle client that fails with no `error` listener crashes the process.
 */
export function createAppPool(url: string, onError: (error: Error) => void): AppPool {
  const pool = new Pool({
    connectionString: url,
    max: MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  });
  pool.on("error", onError);
  return pool;
}
