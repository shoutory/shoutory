import { PgBoss } from "pg-boss";

const POOL_MAX = 4;
const CONNECT_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 30_000;

// The worker role holds DML only: the schema and queues are installed by `shoutory migrate`, so this client never
// migrates, creates the schema, writes queue statistics or reindexes. An `error` event with no listener ends the process.
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
