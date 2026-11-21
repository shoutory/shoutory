/**
 * What a simulator route can be told to do instead of answering normally. `afterEffect` means the route's handler runs
 * first, so the effect happened at the provider and only the answer changes: the case a real provider makes hard (a 5xx
 * after the post exists).
 */
export type Fault =
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly afterEffect?: boolean;
    }
  // The request is never answered. With `effectDelayMs` the handler runs that long after the request (late success: the
  // post appears after the caller already gave up).
  | { readonly kind: "hang"; readonly effectDelayMs?: number }
  // A 200 answer whose body ends short of its Content-Length; the handler has run.
  | { readonly kind: "truncate" };

export interface FaultQueue {
  /** Arms the fault for the next request to the route; faults queue in order. */
  failNext(route: string, fault: Fault): void;
  /** The oldest fault armed for the route, removed from the queue. */
  take(route: string): Fault | undefined;
  /** How many armed faults no request has used yet, so a test can fail on one it never triggered. */
  pending(): number;
}

export function createFaultQueue(): FaultQueue {
  const queues = new Map<string, Fault[]>();
  return {
    failNext: (route, fault) => {
      queues.set(route, [...(queues.get(route) ?? []), fault]);
    },
    take: (route) => queues.get(route)?.shift(),
    pending: () => [...queues.values()].reduce((total, queue) => total + queue.length, 0),
  };
}
