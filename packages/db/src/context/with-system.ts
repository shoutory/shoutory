import type { Pool } from "pg";
import { z } from "zod";
import { type TenantTx, withTenant } from "./with-tenant.js";

// The work a worker does for no tenant: it runs as a job principal with no workspace, under one purpose from a closed
// list. The purpose names the job in the context only; each definer still sets its own purpose to read a table.
export const SYSTEM_PURPOSES = ["outbox_relay", "mail_sender", "maintenance", "heartbeat"] as const;
export type SystemPurpose = (typeof SYSTEM_PURPOSES)[number];

const purposeSchema = z.enum(SYSTEM_PURPOSES);

/** Runs `run` in one transaction as a job with `purpose`; a purpose outside the list is refused before any statement. */
export async function withSystem<T>(
  pool: Pool,
  purpose: SystemPurpose,
  run: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenant(pool, { principalKind: "job", jobPurpose: purposeSchema.parse(purpose) }, run);
}
