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
/**
 * One handler per event type; an event whose type has none is left for the lease to lapse. The signal aborts when the
 * handler has run too long: it must stop its work then, since the row is no longer its to end.
 */
export type OutboxHandlers = Readonly<
  Record<string, (event: OutboxEvent, signal: AbortSignal) => Promise<void>>
>;

export interface OutboxRelay {
  /** Claims one batch, runs the handlers and marks what was delivered; answers how many rows it marked. */
  tick(): Promise<number>;
  /** Ticks until stopped (R317: an interval loop, not a queue schedule, so lag stays far under its limit). Once only. */
  start(): void;
  /** Stops the loop and waits a bounded time for a tick in flight. */
  stop(): Promise<void>;
}

export interface OutboxRelayOptions {
  readonly pool: AppPool;
  readonly handlers: OutboxHandlers;
  readonly logger: Logger;
  readonly batch?: number;
  /** A handler that runs longer is aborted and its row stays unmarked; well inside the 5-minute lease. */
  readonly handlerTimeoutMs?: number;
  readonly intervalMs?: number;
  /** How long `stop` waits for a tick in flight. */
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

class HandlerTimeout extends Error {
  override readonly name = "HandlerTimeout";
}

/** Runs one handler under a timeout: on expiry the promise rejects first, then the signal aborts. */
function runWithin(handler: OutboxHandlers[string], event: OutboxEvent, ms: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HandlerTimeout("the outbox handler ran past its timeout"));
      controller.abort();
    }, ms);
  });
  return Promise.race([handler(event, controller.signal), expired]).finally(() => clearTimeout(timer));
}

/** Waits for `promise`, but no longer than `ms`. */
async function waitUpTo(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise, limit]);
  clearTimeout(timer);
}

export interface IntervalLoop {
  /** Ticks until stopped. Once only: a second start, or a start after stop, throws. */
  start(): void;
  /** Stops the loop and waits a bounded time for a tick in flight. */
  stop(): Promise<void>;
}

/**
 * An interval loop (R317): one tick in flight at a time, the next scheduled when it ends, a failed tick logged and
 * never fatal. The outbox relay and the mail sender both run on it; `name` words their log line and their start error.
 */
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

/**
 * Runs the handler of one claimed row, then marks it with the claim's attempt; true when the mark took. A failure is
 * logged by type and error class only: an error message may carry the payload.
 */
async function deliver(
  { pool, handlers, logger, handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS }: OutboxRelayOptions,
  row: Claimed,
): Promise<boolean> {
  const handler = handlers[row.type];
  if (!handler) {
    logger.error({ type: row.type, id: row.id }, "outbox event has no handler");
    return false;
  }
  try {
    const event = {
      id: row.id,
      type: row.type,
      workspaceId: row.workspace_id,
      payload: row.payload,
      attempts: row.attempts,
    };
    await runWithin(handler, event, handlerTimeoutMs);
  } catch (error) {
    const kind = error instanceof Error ? error.name : "NonError";
    logger.error({ type: row.type, id: row.id, error: kind }, "outbox handler failed");
    return false;
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

/**
 * Delivery is at least once. A claim is a short transaction that leases the rows; the handler runs after it
 * ended (no external call inside a transaction, AGENTS 3.7); the mark names the attempt the claim handed out, so a
 * claimer whose lease lapsed cannot end a row another one holds. A failed, timed-out or unhandled event stays
 * unmarked: its lease lapses and the lag shows it, never a simulated success.
 */
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const {
    pool,
    logger,
    batch = DEFAULT_BATCH,
    intervalMs = DEFAULT_INTERVAL_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  } = options;

  async function tick(): Promise<number> {
    const claimed = await withSystem(pool, "outbox_relay", (tx) =>
      tx.query<Claimed>("SELECT * FROM app.outbox_claim($1)", [batch]),
    );
    let marked = 0;
    for (const row of claimed.rows) if (await deliver(options, row)) marked += 1;
    return marked;
  }

  return { tick, ...intervalLoop("outbox relay", tick, logger, intervalMs, stopTimeoutMs) };
}
