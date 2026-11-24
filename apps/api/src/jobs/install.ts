import { PgBoss } from "pg-boss";
import { JOB_QUEUES, PROVIDER_QUEUE_OPTIONS } from "./registry.js";

// This file imports no workspace package: the test setup that installs the template database loads it outside the
// `source` resolve condition, where a workspace import would need a built `dist`.

// The queue library names no privileges itself. This database does not leave EXECUTE with PUBLIC, so the worker is
// granted its functions explicitly; the definer role reads the job table for the readiness lag.
const GRANTS = `
  GRANT USAGE ON SCHEMA pgboss TO shoutory_worker, shoutory_definer;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO shoutory_worker;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO shoutory_worker;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shoutory_worker;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO shoutory_worker;
  GRANT SELECT ON pgboss.job TO shoutory_definer;`;
const INSTALL_POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 5_000;

export async function installJobs(ownerUrl: string, providerQueues: readonly string[] = []): Promise<void> {
  const failures: Error[] = [];
  const boss = new PgBoss({
    connectionString: ownerUrl,
    application_name: "shoutory-migrate",
    max: INSTALL_POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    migrate: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  boss.on("error", (error) => failures.push(error));
  await boss.start();
  try {
    // No library retries: the ledger decides retries.
    for (const name of Object.keys(JOB_QUEUES)) await boss.createQueue(name, { retryLimit: 0 });
    for (const name of providerQueues) await boss.createQueue(name, PROVIDER_QUEUE_OPTIONS);
    await boss.getDb().executeSql(GRANTS);
  } finally {
    await boss.stop({ graceful: true });
  }
  if (failures[0]) throw failures[0];
}
