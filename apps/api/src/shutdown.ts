import type { Server } from "node:http";

/**
 * How long a stop may take before the process gives up waiting: below the 10 seconds a container runtime waits after
 * SIGTERM before it kills the process, so the process's own exit comes first and says why.
 */
const DRAIN_TIMEOUT_MS = 8_000;

const IDLE_SWEEP_MS = 50;

// A connection a client keeps open after its answer would hold the stop until the keep-alive timeout, so idle ones
// are closed as they fall idle; one with a request still running is left alone.
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((done, fail) => {
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
    server.close((error) => {
      clearInterval(sweep);
      if (error) fail(error);
      else done();
    });
    server.closeIdleConnections();
  });
}

export async function closeTogether(closers: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(closers.map((close) => close()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

export function firstOnly(handler: () => void): () => void {
  let handled = false;
  return () => {
    if (handled) return;
    handled = true;
    handler();
  };
}

export type DrainOutcome = { readonly code: 0 } | { readonly code: 1; readonly reason: "timeout" | "failed" };

export async function drain(
  close: () => Promise<void>,
  { timeoutMs = DRAIN_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<DrainOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<DrainOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ code: 1, reason: "timeout" }), timeoutMs);
  });
  const closed = close().then(
    (): DrainOutcome => ({ code: 0 }),
    (): DrainOutcome => ({ code: 1, reason: "failed" }),
  );
  try {
    return await Promise.race([closed, expired]);
  } finally {
    clearTimeout(timer);
  }
}
