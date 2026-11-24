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
 * queue. Admission takes a target up to its dispatch margin before it is due, so this wake-up can come before the post is
 * due: the end of every tick wakes each publish queue again (`createLedgerTick`), which sends it when it falls due and
 * covers a wake-up that is lost.
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
  /** The adapter of each provider the tick reads back for; a provider with none is only swept and admitted. */
  readonly adapters?: AdapterMap;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  /** The key ring the credentials of the channels are opened with. */
  readonly keys: KeyProvider;
  /** The calendar time, for the sunset of an API version; the default is the real clock. */
  readonly clock?: () => Date;
  readonly intervalMs?: number;
}
export interface LedgerTick extends IntervalLoop {
  /** One pass: the two sweeps, then admission. A step that fails is logged and the others still run. */
  tick(): Promise<void>;
}

// Worked out at each tick: a provider whose API retires between two ticks leaves the live list at the next one.
const sweepsAt = (registry: Registry, now: Date) =>
  sweepArguments(registry.manifests.map((manifest) => ({ ...manifest, live: !pastSunset(manifest, now) })));

type Step = (name: string, run: () => Promise<unknown>) => Promise<void>;
// Runs one step of the tick; a step that fails is logged and the others still run.
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

// One wake-up for the publish queue of each provider that can send, each in its own logged step so that one failing send
// does not skip the others; the queue keeps one waiting wake-up of this key.
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
  // Admits batch after batch while one comes back full, so a backlog does not wait a tick for each hundred.
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
    // A post is admitted up to its dispatch margin before it is due, and the wake-up of admission comes then: waking the
    // queues at the end of every tick sends it when it falls due, and covers a wake-up that was lost.
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
