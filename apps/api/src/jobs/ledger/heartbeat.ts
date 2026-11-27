import { type Claim, heartbeat } from "@shoutory/core/ledger/client";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Logger } from "../../logging/logger.js";
import { type Held, inJob, type Operation, sqlOf } from "./held.js";

export interface HeartbeatOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly workspaceId: string;
  readonly id: string;
  readonly token: string | number;
  readonly owner: string;
  readonly leaseSeconds: number;
  readonly now?: () => number;
  // Taken before the claim, so the lease end is never counted later than the database counts it.
  readonly claimStartedMs?: number;
}
export interface Heartbeat {
  readonly signal: AbortSignal;
  /** The lease end the last beat renewed, on the clock the heartbeat runs by. */
  leaseEnd(): number;
  stop(): Promise<void>;
}

const extendLease = ({ pool, workspaceId, id, token, owner, leaseSeconds }: HeartbeatOptions) =>
  inJob(pool, workspaceId, (tx) =>
    heartbeat(sqlOf(tx), { id, token: String(token), owner, extendSeconds: leaseSeconds }),
  );

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let give: NodeJS.Timeout | undefined;
  const slow = new Promise<never>((_, reject) => {
    give = setTimeout(() => reject(new Error("the heartbeat took too long")), ms);
  });
  try {
    return await Promise.race([work, slow]);
  } finally {
    clearTimeout(give);
  }
}

// The deadline timer aborts the signal when no beat took in time, so a worker that cannot prove it still holds the
// lease stops before the lease ends, whether the database errs or hangs.
export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  const { logger, leaseSeconds, now = () => performance.now() } = options;
  const controller = new AbortController();
  const leaseMs = leaseSeconds * 1000;
  // A beat gets a third of the lease; a beat still waiting after that counts as failed.
  const every = leaseMs / 3;
  let leaseEnd = (options.claimStartedMs ?? now()) + leaseMs;
  let timer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  function armDeadline(): void {
    clearTimeout(deadline);
    deadline = setTimeout(() => controller.abort(), Math.max(0, leaseEnd - now()));
  }
  async function beat(): Promise<void> {
    const began = now();
    try {
      if ((await within(extendLease(options), every)) === "lost") return controller.abort();
      leaseEnd = began + leaseMs;
      armDeadline();
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.name : "NonError" }, "ledger heartbeat failed");
    }
    schedule();
  }
  function schedule(): void {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      inFlight = beat();
    }, every);
  }
  armDeadline();
  schedule();
  return {
    signal: controller.signal,
    leaseEnd: () => leaseEnd,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      await inFlight;
    },
  };
}

export interface HoldOptions {
  readonly pool: AppPool;
  readonly logger: Logger;
  readonly claim: Claim;
  readonly operation: Operation;
  readonly manifest: Manifest;
  readonly leaseSeconds: number;
  readonly owner: string;
  readonly now: () => number;
  readonly started: number;
}

export function hold(options: HoldOptions): { held: Held; stop: () => Promise<void> } {
  const { claim, operation, manifest, leaseSeconds, started } = options;
  const beating = startHeartbeat({
    pool: options.pool,
    logger: options.logger,
    workspaceId: claim.workspaceId,
    id: claim.id,
    token: claim.fencingToken,
    owner: options.owner,
    leaseSeconds,
    now: options.now,
    claimStartedMs: started,
  });
  return {
    held: {
      claim,
      operation,
      manifest,
      leaseSeconds,
      started,
      signal: beating.signal,
      leaseEnd: beating.leaseEnd,
    },
    stop: () => beating.stop(),
  };
}
