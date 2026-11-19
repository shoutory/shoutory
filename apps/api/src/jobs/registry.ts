import { z } from "zod";

// The one table of the queues the worker role runs. A job is a wake-up: its payload names the retention class and
// nothing that grants authority, so every schema is strict and a `role` or workspace field is refused (NFR-SEC-24).
const retentionClass = z.string().regex(/^[a-z_.]{1,64}$/);

export const JOB_QUEUES = {
  ensure_partitions: { payload: z.strictObject({}), cron: "17 2 * * *" },
  purge_expired: { payload: z.strictObject({ class: retentionClass }), cron: "41 2 * * *" },
} as const;
export type JobQueue = keyof typeof JOB_QUEUES;

/** The retention classes that drop partitions: their purge takes the maintenance lock, a window class's does not. */
export const PARTITION_CLASSES = ["audit_logs", "outbox"] as const;

/** The retention classes of `app.retention_classes`; `purge_expired` is scheduled once for each (a test keeps them equal). */
export const RETENTION_CLASSES = [
  "audit_logs",
  "outbox",
  "email_outbox",
  "auth.session",
  "auth.verification",
  "app.session_step_ups",
  "app.invitations",
  "app.rate_buckets",
  "app.worker_heartbeats",
  "auth.user_unverified",
] as const;

/** Parses the payload of a job of `queue`; a payload with a field the schema does not name is refused. */
export function parseJobPayload<Q extends JobQueue>(
  queue: Q,
  data: unknown,
): z.output<(typeof JOB_QUEUES)[Q]["payload"]> {
  return JOB_QUEUES[queue].payload.parse(data) as z.output<(typeof JOB_QUEUES)[Q]["payload"]>;
}
