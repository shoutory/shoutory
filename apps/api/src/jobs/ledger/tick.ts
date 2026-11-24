import { randomUUID } from "node:crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { providersArgument, sweepArguments } from "@shoutory/core/ledger/client";
import type { TenantTx } from "@shoutory/db/context";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import { pastSunset } from "@shoutory/provider-sdk/snapshot";
import type { PgBoss } from "pg-boss";
import type { Logger } from "../../logging/logger.js";
import { type IntervalLoop, intervalLoop } from "../outbox-relay.js";
import { refuseEgress } from "./held.js";
import { reconcileStep } from "./reconcile.js";

const TICK_MS = 30_000;
const STOP_MS = 10_000;
// Targets taken in one call; the database caps a call at 500.
const ADMIT_BATCH = 100;
// One tick takes at most this many batches, so one tick never holds the worker for ever.
const MAX_ADMIT_BATCHES = 5;

export interface Admitted {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly queue: string;
  readonly state: string;
}

const bossDb = (tx: TenantTx) => ({
  executeSql: (text: string, values?: unknown[]) => tx.query(text, values),
});

// The wake-up is sent inside the transaction of `tx`: a rollback leaves no job, and a commit never leaves an operation
// without its job.
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
  readonly adapters?: AdapterMap;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly keys: KeyProvider;
  readonly clock?: () => Date;
  readonly intervalMs?: number;
}
export interface LedgerTick extends IntervalLoop {
  tick(): Promise<void>;
}

// Worked out at each tick: a provider whose API retires between two ticks leaves the live list at the next one.
const sweepsAt = (registry: Registry, now: Date) =>
  sweepArguments(registry.manifests.map((manifest) => ({ ...manifest, live: !pastSunset(manifest, now) })));

// A step that fails is logged and the others still run.
type Step = (name: string, run: () => Promise<unknown>) => Promise<void>;
const stepper =
  (logger: Logger): Step =>
  async (name, run) => {
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

// Each send is its own logged step so that one failing send does not skip the others.
async function wakePublish(
  step: Step,
  boss: PgBoss,
  registry: Registry,
  adapters: AdapterMap,
): Promise<void> {
  for (const manifest of registry.manifests) {
    if (adapters[manifest.id] === undefined) continue;
    const queue = registry.queueNames(manifest.id).publish;
    await step(`wake ${manifest.id}`, () => boss.send(queue, {}, { singletonKey: "wake", retryLimit: 0 }));
  }
}

export function createLedgerTick({
  pool,
  boss,
  registry,
  logger,
  adapters = {},
  fetchFor = refuseEgress,
  keys,
  clock = () => new Date(),
  intervalMs = TICK_MS,
}: LedgerTickOptions): LedgerTick {
  const owner = `tick-${randomUUID()}`;
  const closing = new AbortController();
  const step = stepper(logger);
  const wake = () => wakePublish(step, boss, registry, adapters);
  // A sweep that put rows back in play wakes the publish queues at once: a shortcut for latency, since the wake at the
  // end of the tick sends them anyway.
  const sweep = (sql: string, argument: Record<string, unknown>) => async () => {
    const moved = await withSystem(pool, "ledger", async (tx) =>
      Number((await tx.query<{ n: number }>(sql, [JSON.stringify(argument)])).rows[0]?.n ?? 0),
    );
    if (moved > 0) await wake();
  };
  async function admitBacklog(): Promise<void> {
    for (let batch = 0; batch < MAX_ADMIT_BATCHES; batch++) {
      const admitted = await withSystem(pool, "ledger", (tx) => admitAndWake(tx, boss, registry));
      if (admitted.length < ADMIT_BATCH) return;
    }
  }
  async function tick(): Promise<void> {
    // One reading of the clock for the whole tick: both sweeps see the same live list.
    const sweeps = sweepsAt(registry, clock());
    await step("expired leases", sweep("SELECT app.sweep_expired_leases($1::jsonb) AS n", sweeps.leases));
    await step("due moves", sweep("SELECT app.sweep_due_moves($1::jsonb) AS n", sweeps.due));
    await step("admission", admitBacklog);
    await step("reconcile", () =>
      reconcileStep({ pool, logger, registry, adapters, fetchFor, keys, owner, closing: closing.signal }),
    );
    // A post is admitted before it is due, so the wake-up of admission can come early: waking the queues at the end of
    // every tick sends it when it falls due, and covers a wake-up that was lost.
    await wake();
  }
  const loop = intervalLoop("ledger tick", tick, logger, intervalMs, STOP_MS);
  return {
    tick,
    start: loop.start,
    // A reconcile in flight hands its row back instead of finishing a call the worker is closing on.
    stop: () => {
      closing.abort();
      return loop.stop();
    },
  };
}
