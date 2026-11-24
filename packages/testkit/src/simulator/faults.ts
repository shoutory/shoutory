// `afterEffect` runs the route's handler first, so the effect happened and only the answer changes (a 5xx after the post exists).
export type Fault =
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly afterEffect?: boolean;
    }
  // With `effectDelayMs` the handler runs that long after the request: a late success after the caller gave up.
  | { readonly kind: "hang"; readonly effectDelayMs?: number }
  // A 200 whose body ends short of its Content-Length; the handler has run.
  | { readonly kind: "truncate" };

export interface FaultQueue {
  failNext(route: string, fault: Fault): void;
  take(route: string): Fault | undefined;
  /** So a test can fail on a fault it never triggered. */
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
