import { PgBoss } from "pg-boss";

const POOL_MAX = 4;
const CONNECT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * The job queue client of the worker role. The owner installed the schema and every queue (`shoutory migrate`), so
 * this client never migrates, never creates the schema, keeps no queue statistics table and never rebuilds an index:
 * the worker role holds DML only. Its pool is bounded like every other pool (AGENTS 6.6), and an `error` event is
 * reported through `onError`, since an event with no listener would end the process.
 */
export function createBoss(connectionString: string, onError: (error: Error) => void): PgBoss {
  const boss = new PgBoss({
    connectionString,
    application_name: "shoutory-worker",
    max: POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    migrate: false,
    createSchema: false,
    persistQueueStats: false,
    reindex: false,
  });
  boss.on("error", onError);
  return boss;
}
