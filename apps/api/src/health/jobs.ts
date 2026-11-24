import type { AppPool } from "@shoutory/db/pool";
import { isUnavailable, Refusal } from "../errors/refusal.js";

// A worker counts as stale after 90 s inside `app.worker_status()`.
const OUTBOX_LAG_SECONDS = 60;
const JOB_LAG_SECONDS = 120;

async function ask<R extends object>(pool: AppPool, sql: string): Promise<R[]> {
  try {
    return (await pool.query(sql)).rows as R[];
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    throw new Refusal("service_unavailable", "database unreachable", {
      cause: error,
      details: { cause: "database_unreachable" },
    });
  }
}

const notReady = (cause: string, message: string) =>
  new Refusal("service_unavailable", message, { details: { cause } });

// A stale worker row beside a fresh one is ignored: worker ids are per process and a dead worker's row stays for days.
export async function assertJobsHealthy(pool: AppPool): Promise<void> {
  const [outbox] = await ask<{ lag: number }>(pool, "SELECT app.outbox_lag() AS lag");
  if ((outbox?.lag ?? 0) > OUTBOX_LAG_SECONDS) throw notReady("outbox_lag", "the outbox relay is behind");
  const workers = await ask<{ stale: boolean }>(pool, "SELECT stale FROM app.worker_status()");
  if (!workers.some((worker) => !worker.stale)) throw notReady("no_worker", "no worker has beaten recently");
  const [jobs] = await ask<{ installed: boolean; lag_seconds: number | null }>(
    pool,
    "SELECT installed, lag_seconds FROM app.job_lag()",
  );
  if (!jobs?.installed) throw notReady("jobs_not_installed", "the job queue is not installed");
  if ((jobs.lag_seconds ?? 0) > JOB_LAG_SECONDS) throw notReady("job_lag", "the job queue is behind");
}
