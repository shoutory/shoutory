import { z } from "zod";

// A job payload carries nothing that grants authority, so every schema is strict and a `role` or workspace field is refused.
const retentionClass = z.string().regex(/^[a-z_.]{1,64}$/);

export const JOB_QUEUES = {
  ensure_partitions: { payload: z.strictObject({}), cron: "17 2 * * *" },
  purge_expired: { payload: z.strictObject({ class: retentionClass }), cron: "41 2 * * *" },
  media_gc: { payload: z.strictObject({}), cron: "11 3 * * *" },
  // Scheduled only for the filesystem driver.
  sweep_upload_parts: { payload: z.strictObject({}), cron: "23 3 * * *" },
} as const;
export type JobQueue = keyof typeof JOB_QUEUES;

// At most one waiting wake-up and no retries: the ledger row is the truth.
export const PROVIDER_QUEUE_OPTIONS = { retryLimit: 0, policy: "short" } as const;

// Their purge takes the maintenance lock; a window class's does not.
export const PARTITION_CLASSES = ["audit_logs", "outbox"] as const;

export const RETENTION_CLASSES = [
  "audit_logs",
  "outbox",
  "email_outbox",
  "auth.session",
  "auth.verification",
  "app.session_step_ups",
  "app.invitations",
  "app.oauth_flows",
  "app.connect_challenges",
  "app.media_uploads",
  "app.idempotency_keys",
  "app.operation_attempts",
  "app.usage_reservations",
  "app.provider_quota_ledger",
  "app.rate_buckets",
  "app.worker_heartbeats",
  "auth.user_unverified",
] as const;

export function parseJobPayload<Q extends JobQueue>(
  queue: Q,
  data: unknown,
): z.output<(typeof JOB_QUEUES)[Q]["payload"]> {
  return JOB_QUEUES[queue].payload.parse(data) as z.output<(typeof JOB_QUEUES)[Q]["payload"]>;
}
