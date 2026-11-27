// The rules of a disconnect, with no I/O: which operations stand in its way, and what the person is shown before it.

// An operation in one of these states may be talking to the provider or waits for a person, so a disconnect is refused
// while one exists. Cancel and attest stay possible, which is how it is cleared.
export const BLOCKING_STATES = [
  "claimed",
  "dispatching",
  "provider_accepted",
  "unknown_external_state",
  "reconciling",
  "needs_human",
  "unverified",
] as const;

const BLOCKING: ReadonlySet<string> = new Set(BLOCKING_STATES);
export const isBlocking = (state: string): boolean => BLOCKING.has(state);

export interface ScheduledTarget {
  readonly variantId: string;
  readonly postId: string;
  readonly dueAt: string | null;
}

export interface OperationRow {
  readonly id: string;
  readonly state: string;
}

export interface DisconnectImpact {
  /** Posts scheduled for the channel, admitted or not; they wait for a reconnect and are kept. */
  readonly scheduled: readonly ScheduledTarget[];
  /** Operations that stop a disconnect now; each is cleared by cancelling or attesting it. */
  readonly blocking: readonly OperationRow[];
  readonly canDisconnect: boolean;
}

export function impactOf(
  scheduled: readonly ScheduledTarget[],
  operations: readonly OperationRow[],
): DisconnectImpact {
  const blocking = operations.filter((operation) => isBlocking(operation.state));
  return { scheduled, blocking, canDisconnect: blocking.length === 0 };
}
