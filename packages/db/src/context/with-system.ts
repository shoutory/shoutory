import type { Pool } from "pg";
import { z } from "zod";
import { type TenantTx, withTenant } from "./with-tenant.js";

// The purpose names the job in the context only; each definer still sets its own purpose to read a table.
export const SYSTEM_PURPOSES = [
  "outbox_relay",
  "mail_sender",
  "maintenance",
  "heartbeat",
  "ledger",
  "credential_refresh",
  "connect_challenge_poll",
  "provider_documents",
] as const;
export type SystemPurpose = (typeof SYSTEM_PURPOSES)[number];

const purposeSchema = z.enum(SYSTEM_PURPOSES);

export async function withSystem<T>(
  pool: Pool,
  purpose: SystemPurpose,
  run: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenant(pool, { principalKind: "job", jobPurpose: purposeSchema.parse(purpose) }, run);
}
