import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Logger } from "../logging/logger.js";

interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly workspaceId: string | null;
  readonly payload: unknown;
  readonly attempts: number;
}
// The signal aborts when the handler has run too long: it must stop its work then, since the row is no longer its to end.
export type OutboxHandlers = Readonly<
  Record<string, (event: OutboxEvent, signal: AbortSignal) => Promise<void>>
>;

export interface OutboxRelay {
  tick(): Promise<number>;
  // An interval loop, not a queue schedule, so lag stays far under its limit.
  start(): void;
  stop(): Promise<void>;
}

export interface OutboxRelayOptions {
  readonly pool: AppPool;
  readonly handlers: OutboxHandlers;
  readonly logger: Logger;
  readonly batch?: number;
  // Inside the 5-minute lease, unless a heartbeat keeps the claim.
  readonly handlerTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly types?: readonly string[];
  readonly excludeTypes?: readonly string[];
  readonly intervalMs?: number;
  readonly stopTimeoutMs?: number;
}

interface Claimed {
  id: string;
  created_at: string;
  type: string;
  workspace_id: string | null;
  payload: unknown;
  attempts: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_BATCH = 50;
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

class HandlerAborted extends Error {
  constructor(override readonly name: "HandlerTimeout" | "ClaimLost" | "RelayStopping") {
    super(`the outbox handler was stopped: ${name}`);
  }
}

// Any abort ends the wait at once: the row is no longer this handler's to end.
function runWithin(
  handler: OutboxHandlers[string],
  event: OutboxEvent,
  ms: number,
  controller: AbortController,
): Promise<void> {
  const timer = setTimeout(() => controller.abort(new HandlerAborted("HandlerTimeout")), ms);
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([handler(event, controller.signal), aborted]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  });
}

// Beats run one after another; a beat that fails to reach the database is logged and the next one tries again, since
// only an answer of false means the claim is lost. The returned stop waits for a beat in flight.
function keepClaim(
  { pool, logger, heartbeatMs }: OutboxRelayOptions,
  row: Claimed,
  controller: AbortController,
): () => Promise<void> {
  if (heartbeatMs === undefined) return async () => undefined;
  let live = true;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const beat = async () => {
    try {
      const kept = await withSystem(pool, "outbox_relay", (tx) =>
        tx.query<{ ok: boolean }>("SELECT app.outbox_heartbeat($1, $2, $3) AS ok", [
          row.id,
          row.created_at,
          row.attempts,
        ]),
      );
      if (live && kept.rows[0]?.ok !== true) controller.abort(new HandlerAborted("ClaimLost"));
    } catch (error) {
      logger.error({ type: row.type, id: row.id, error: errorKind(error) }, "outbox heartbeat failed");
    }
    if (live && !controller.signal.aborted) schedule();
  };
  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = beat();
    }, heartbeatMs);
  };
  schedule();
  return () => {
    live = false;
    clearTimeout(timer);
    return inFlight;
  };
}

const errorKind = (error: unknown) => (error instanceof Error ? error.name : "NonError");

async function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, limit]);
  clearTimeout(timer);
}

export interface IntervalLoop {
  start(): void;
  stop(): Promise<void>;
}

export function intervalLoop(
  name: string,
  tick: () => Promise<unknown>,
  logger: Logger,
  intervalMs: number,
  stopMs: number,
): IntervalLoop {
  let state: "idle" | "running" | "stopped" = "idle";
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  function schedule(): void {
    timer = setTimeout(() => {
      running = tick()
        .then(() => undefined)
        .catch((error: unknown) => logger.error({ err: error }, `${name} tick failed`))
        .finally(() => {
          if (state === "running") schedule();
        });
    }, intervalMs);
  }
  return {
    start() {
      if (state !== "idle") throw new Error(`the ${name} starts once`);
      state = "running";
      schedule();
    },
    async stop() {
      state = "stopped";
      clearTimeout(timer);
      await waitUpTo(running, stopMs);
    },
  };
}

// A failure is logged by type and error class only: an error message may carry the payload.
async function deliver(
  options: OutboxRelayOptions,
  row: Claimed,
  controller: AbortController,
): Promise<boolean> {
  const { pool, handlers, logger, handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS } = options;
  const handler = handlers[row.type];
  if (!handler) {
    logger.error({ type: row.type, id: row.id }, "outbox event has no handler");
    return false;
  }
  const stopBeats = keepClaim(options, row, controller);
  try {
    const event = {
      id: row.id,
      type: row.type,
      workspaceId: row.workspace_id,
      payload: row.payload,
      attempts: row.attempts,
    };
    await runWithin(handler, event, handlerTimeoutMs, controller);
  } catch (error) {
    logger.error({ type: row.type, id: row.id, error: errorKind(error) }, "outbox handler failed");
    return false;
  } finally {
    await stopBeats();
  }
  const marked = await withSystem(pool, "outbox_relay", (tx) =>
    tx.query<{ ok: boolean }>("SELECT app.outbox_mark($1, $2, $3) AS ok", [
      row.id,
      row.created_at,
      row.attempts,
    ]),
  );
  if (!marked.rows[0]?.ok)
    logger.warn({ type: row.type, id: row.id }, "outbox claim was lost before the mark");
  return marked.rows[0]?.ok === true;
}

// Delivery is at least once. The handler runs after the claim transaction ended (no external call inside a
// transaction); the mark names the claim's attempt, so a claimer whose lease lapsed cannot end a row another one holds.
// A failed, timed-out or unhandled event stays unmarked: its lease lapses and the lag shows it, never a simulated success.
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const {
    pool,
    logger,
    batch = DEFAULT_BATCH,
    types = null,
    excludeTypes = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  } = options;
  const running = new Set<AbortController>();
  let stopping = false;

  async function tick(): Promise<number> {
    const claimed = await withSystem(pool, "outbox_relay", (tx) =>
      tx.query<Claimed>("SELECT * FROM app.outbox_claim($1, $2, $3)", [batch, types, excludeTypes]),
    );
    let marked = 0;
    for (const row of claimed.rows) {
      if (stopping) break;
      const controller = new AbortController();
      running.add(controller);
      try {
        if (await deliver(options, row, controller)) marked += 1;
      } finally {
        running.delete(controller);
      }
    }
    return marked;
  }

  const loop = intervalLoop("outbox relay", tick, logger, intervalMs, stopTimeoutMs);
  return {
    tick,
    start: loop.start,
    // A handler in flight is told to stop, so its work and its beats end before the pool closes.
    async stop() {
      stopping = true;
      for (const controller of running) controller.abort(new HandlerAborted("RelayStopping"));
      await loop.stop();
    },
  };
}
