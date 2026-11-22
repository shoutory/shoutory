import { providersArgument } from "@shoutory/core/ledger/client";
import type { TenantTx } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Registry } from "@shoutory/provider-sdk/registry";
import type { PgBoss } from "pg-boss";
import type { Logger } from "../../logging/logger.js";
import { type IntervalLoop, intervalLoop } from "../outbox-relay.js";

const TICK_MS = 30_000;
const STOP_MS = 10_000;
// Targets taken in one call; the database caps a call at 500.
const ADMIT_BATCH = 100;
// One tick takes at most this many batches, so one tick never holds the worker for ever (AGENTS 6.6).
const MAX_ADMIT_BATCHES = 5;

export interface Admitted {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly queue: string;
  readonly state: string;
}

/** The queue library's database seam on a transaction: its statements run inside the transaction of `tx`. */
const bossDb = (tx: TenantTx) => ({
  executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
});

/**
 * Admits the due targets and sends one wake-up for each queue that got an operation, inside the transaction of `tx`: a
 * rollback leaves no job, and a commit never leaves an operation without its job. The queue keeps one waiting wake-up per
 * queue; the claim of the next tick covers a job that is lost.
 */
export async function admitAndWake(
  tx: TenantTx,
  boss: Pick<PgBoss, "send">,
  registry: Registry,
): Promise<readonly Admitted[]> {
  if (registry.manifests.length === 0) return [];
  const { rows } = await tx.query<Admitted>("SELECT * FROM app.admit_due_targets($1, $2::jsonb)", [
    ADMIT_BATCH,
    JSON.stringify(providersArgument(registry.manifests)),
  ]);
  for (const queue of new Set(rows.map((row) => row.queue))) {
    // A wake-up carries nothing: the ledger row is the truth.
    await boss.send(
      queue,
      {},
      {
        db: bossDb(tx),
        singletonKey: queue,
        retryLimit: 0,
      },
    );
  }
  return rows;
}

export interface LedgerTickOptions {
  readonly pool: AppPool;
  readonly boss: PgBoss;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly intervalMs?: number;
}
export interface LedgerTick extends IntervalLoop {
  /** One pass: the two sweeps, then admission. A step that fails is logged and the others still run. */
  tick(): Promise<void>;
}

export function createLedgerTick({
  pool,
  boss,
  registry,
  logger,
  intervalMs = TICK_MS,
}: LedgerTickOptions): LedgerTick {
  const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const fields = {
        step: name,
        error: error instanceof Error ? error.name : "NonError",
        ...(typeof code === "string" ? { code } : {}),
      };
      logger.error(fields, "ledger tick step failed");
    }
  };
  const call = (sql: string) => () => withSystem(pool, "ledger", (tx) => tx.query(sql));
  // Admits batch after batch while one comes back full, so a backlog does not wait a tick for each hundred.
  async function admitBacklog(): Promise<void> {
    for (let batch = 0; batch < MAX_ADMIT_BATCHES; batch++) {
      const admitted = await withSystem(pool, "ledger", (tx) => admitAndWake(tx, boss, registry));
      if (admitted.length < ADMIT_BATCH) return;
    }
  }
  async function tick(): Promise<void> {
    await step("expired leases", call("SELECT app.sweep_expired_leases()"));
    await step("due moves", call("SELECT app.sweep_due_moves()"));
    await step("admission", admitBacklog);
  }
  return { tick, ...intervalLoop("ledger tick", tick, logger, intervalMs, STOP_MS) };
}
