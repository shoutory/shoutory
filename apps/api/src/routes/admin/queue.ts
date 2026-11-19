import { type App, defineRoute } from "../define-route.js";
import { asAdmin } from "./admin.js";

// The queue health behind the Z-05 screen: the worker heartbeats with their stale flag (silent for 90 s), the age of
// the oldest undispatched outbox event and of the oldest due job. The three definers are granted to the app role and
// are not admin-gated inside (the readiness probe calls them with no user), so the admin check is this route's.
export function registerQueue(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/admin/queue",
    policy: "session",
    access: "user",
    handler: ({ inUserTx }) =>
      asAdmin(inUserTx, async (tx) => {
        const workers = await tx.query(
          "SELECT worker_id, role, started_at, seen_at, stale FROM app.worker_status()",
        );
        const outbox = await tx.query<{ lag: number | null }>("SELECT app.outbox_lag() AS lag");
        const jobs = await tx.query<{ installed: boolean; lag_seconds: number | null }>(
          "SELECT installed, lag_seconds FROM app.job_lag()",
        );
        return {
          workers: workers.rows,
          outbox_lag_seconds: Number(outbox.rows[0]?.lag ?? 0),
          // Before the queue library's schema is installed there is no lag, never a zero.
          jobs: {
            installed: jobs.rows[0]?.installed === true,
            lag_seconds: jobs.rows[0]?.lag_seconds ?? null,
          },
        };
      }),
  });
}
