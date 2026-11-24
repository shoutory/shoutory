import type { Pool, PoolClient } from "pg";
import type { TenantCtx } from "../../src/context/with-tenant.js";

// Helpers for the tests that force two transactions to meet on one lock: the first holds it, the second is seen
// waiting in pg_locks, then the first commits. The settings are set the way withTenant sets them, but the
// transaction stays open for the test to drive.

/** The R178 audit hash recomputed in SQL from the stored columns: counts the rows whose hash is not what the spec says. */
export const HASH_BAD = `SELECT count(*)::int AS bad FROM app.audit_logs WHERE hash <> sha256(prev_hash || convert_to(
  jsonb_build_array(id, workspace_id, organization_id, (extract(epoch FROM at) * 1000000)::bigint, actor_kind,
    actor_ref, action, resource_kind, resource_id, request_id, encode(ip_hmac, 'hex'), metadata)::text, 'UTF8'))`;

type Rows = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const SETTINGS: [string, (ctx: TenantCtx) => string | undefined][] = [
  ["app.organization_id", (ctx) => ctx.organizationId],
  ["app.workspace_ids", (ctx) => (ctx.workspaceIds ? `{${ctx.workspaceIds.join(",")}}` : undefined)],
  ["app.write_workspace_id", (ctx) => ctx.writeWorkspaceId],
  ["app.principal_kind", (ctx) => ctx.principalKind],
  ["app.service_kind", (ctx) => ctx.serviceKind],
  ["app.principal_id", (ctx) => ctx.principalId],
  ["app.portal_grant_id", (ctx) => ctx.portalGrantId],
  ["app.job_purpose", (ctx) => ctx.jobPurpose],
];

/** Opens a transaction on its own connection with the context set; `null` sets nothing. The caller ends it. */
export async function openTx(pool: Pool, ctx: TenantCtx | null): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query("BEGIN");
  if (ctx === null) return client;
  const given = SETTINGS.flatMap(([name, read]) => {
    const value = read(ctx);
    return value === undefined ? [] : [[name, value] as const];
  });
  await client.query(
    "SELECT set_config(s.name, s.value, true) FROM unnest($1::text[], $2::text[]) AS s(name, value)",
    [given.map(([name]) => name), given.map(([, value]) => value)],
  );
  return client;
}

async function waitsForLock(rows: Rows, pid: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await rows("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [pid])).length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second writer never waited for the lock");
}

export interface RaceOutcome {
  /** The error the second writer ended with, if it was refused; its transaction is then rolled back. */
  secondError: unknown;
}

/**
 * tx1 writes and holds, tx2 starts its write and is seen waiting in pg_locks (`rows` runs as the superuser), then tx1
 * commits and tx2 finishes. A refused second writer is rolled back and reported, never thrown. Both clients are released.
 * The second writer has `waitMs` (10 s by default) to be seen waiting; a test whose own limit is shorter passes less, so
 * that a writer that never waits fails with this error and not with the test's timeout.
 */
export async function holdThenRace(
  rows: Rows,
  first: PoolClient,
  second: PoolClient,
  write: (client: PoolClient, n: 1 | 2) => Promise<unknown>,
  waitMs = 10_000,
): Promise<RaceOutcome> {
  try {
    await write(first, 1);
    const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const pending = write(second, 2).then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    await waitsForLock(rows, pid, waitMs);
    await first.query("COMMIT");
    const refused = await pending;
    await second.query(refused ? "ROLLBACK" : "COMMIT");
    return { secondError: refused?.error };
  } finally {
    await endBoth(first, second);
  }
}

// A transaction still open (the first write failed, or the lock wait timed out) is rolled back, so no client goes back
// to the pool mid-transaction; after a commit the ROLLBACK is a harmless notice. A rollback that fails destroys that
// connection and is reported once both clients are released.
async function endBoth(...clients: PoolClient[]): Promise<void> {
  const failures: unknown[] = [];
  for (const client of clients) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (error) {
      failures.push(error);
      client.release(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "the race helper could not roll back a client");
}
