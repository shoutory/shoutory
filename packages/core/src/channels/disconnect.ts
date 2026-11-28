// The rules of a disconnect, with no I/O: which operations stand in its way, and what the person is shown before it.

// An operation in one of these states may be talking to the provider or waits for a person, so a disconnect is refused
// while one exists. Cancel and attest stay possible, which is how it is cleared.
const BLOCKING: ReadonlySet<string> = new Set([
  "claimed",
  "processing",
  "dispatching",
  "provider_accepted",
  "unknown_external_state",
  "reconciling",
  "needs_human",
  "unverified",
]);

/** The most rows of each list a preview or a refusal carries. */
export const LIST_BOUND = 200;

export interface ScheduledTarget {
  readonly variantId: string;
  readonly postId: string;
  readonly dueAt: string | null;
}

export interface OperationRow {
  readonly id: string;
  readonly state: string;
  readonly postId: string;
  readonly channelName: string;
}

export interface DisconnectImpact {
  /** Posts scheduled for the channel, admitted or not; they wait for a reconnect and are kept. */
  readonly scheduled: readonly ScheduledTarget[];
  /** Operations that stop a disconnect now; each is cleared by cancelling or attesting it. */
  readonly blocking: readonly OperationRow[];
  /** True when either list holds more than it shows. */
  readonly truncated: boolean;
  readonly canDisconnect: boolean;
}

export function impactOf(
  scheduled: readonly ScheduledTarget[],
  operations: readonly OperationRow[],
): DisconnectImpact {
  const blocking = operations.filter((operation) => BLOCKING.has(operation.state));
  return {
    scheduled: scheduled.slice(0, LIST_BOUND),
    blocking: blocking.slice(0, LIST_BOUND),
    truncated: scheduled.length > LIST_BOUND || blocking.length > LIST_BOUND,
    canDisconnect: blocking.length === 0,
  };
}
