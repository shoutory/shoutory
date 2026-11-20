import { Trans, useLingui } from "@lingui/react/macro";
import { z } from "zod";
import { readZone, useDigits } from "../account/prefs";
import { useLoad } from "../account/use-load";
import { formatNumber, type Locale } from "../i18n/i18n";
import { Listed } from "../settings/member-actions";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";
import { LocalizedDateTime } from "../ui/localized";
import { NotAvailable } from "./not-available";

const queueSchema = z.object({
  workers: z.array(
    z.object({
      worker_id: z.string(),
      role: z.string(),
      seen_at: z.iso.datetime({ offset: true }),
      stale: z.boolean(),
    }),
  ),
  outbox_lag_seconds: z.number(),
  jobs: z.object({ installed: z.boolean(), lag_seconds: z.number().nullable() }),
});
type Queue = z.infer<typeof queueSchema>;

function Seconds({ value }: { value: number }) {
  const { i18n } = useLingui();
  const seconds = formatNumber(value, { locale: i18n.locale as Locale, digits: useDigits() });
  return <Trans id="admin.queue.seconds">{seconds} s</Trans>;
}

function WorkerTable({ workers }: { workers: Queue["workers"] }) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto" data-testid="queue-scroll">
      <table aria-label={t({ id: "admin.queue.workers", message: "Workers" })} className="w-full text-start">
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="admin.queue.col_worker">Worker</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.queue.col_role">Role</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.queue.col_seen">Last seen</Trans>
            </th>
            <th className="text-start">
              <Trans id="admin.queue.col_state">State</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.worker_id}>
              <td className="py-2 pe-5 wrap-anywhere">
                <DirText dir="ltr">{worker.worker_id}</DirText>
              </td>
              <td className="py-2 pe-5">
                <DirText dir="ltr">{worker.role}</DirText>
              </td>
              <td className="py-2 pe-5">
                <LocalizedDateTime value={new Date(worker.seen_at)} timeZone={readZone()} />
              </td>
              <td className="py-2">
                {worker.stale ? (
                  <strong>
                    <Trans id="admin.queue.stale">Stale (worker silent)</Trans>
                  </strong>
                ) : (
                  <Trans id="admin.queue.running">Running</Trans>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Measures({ queue }: { queue: Queue }) {
  return (
    <dl className="flex max-w-md flex-col gap-3">
      <div>
        <dt className="font-medium">
          <Trans id="admin.queue.outbox_lag">Event outbox lag</Trans>
        </dt>
        <dd>
          <Seconds value={queue.outbox_lag_seconds} />
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <Trans id="admin.queue.job_lag">Job queue lag</Trans>
        </dt>
        <dd>
          {queue.jobs.installed && queue.jobs.lag_seconds !== null ? (
            <Seconds value={queue.jobs.lag_seconds} />
          ) : (
            <Trans id="admin.queue.jobs_missing">The job queue is not installed</Trans>
          )}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <Trans id="admin.queue.stuck">Stuck operations</Trans>
        </dt>
        <dd>
          <NotAvailable />
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <Trans id="admin.queue.reconciler">Reconciler backlog</Trans>
        </dt>
        <dd>
          <NotAvailable />
        </dd>
      </div>
    </dl>
  );
}

/** Z-05: the workers, the lag of the outbox and the job queue, and what cannot be measured yet. */
export function QueuePage() {
  const { state, reload } = useLoad(queueSchema, "/api/v1/admin/queue");
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.queue.title">Queue health</Trans>
      </h1>
      <Listed state={state} reload={reload}>
        {(queue) => (
          <>
            {queue.workers.length === 0 ? (
              <EmptyState
                kind="first-use"
                title={<Trans id="admin.queue.no_worker">No worker has reported</Trans>}
              >
                <Trans id="admin.queue.no_worker_body">
                  Nothing processes mail or jobs until a worker starts and reports.
                </Trans>
              </EmptyState>
            ) : (
              <WorkerTable workers={queue.workers} />
            )}
            <Measures queue={queue} />
          </>
        )}
      </Listed>
    </>
  );
}
