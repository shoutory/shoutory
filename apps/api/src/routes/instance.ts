import type { AppPool } from "@shoutory/db/pool";
import { type App, defineRoute } from "./define-route.js";

// Cached for at most 5 s, so the database sees at most one call per 5 s per process whatever the request rate (flood
// protection beyond that is the operator's proxy, as for every public read).
const CACHE_MS = 5_000;

export function registerInstance(app: App, pool: AppPool, now: () => number): void {
  let cached: { readonly at: number; readonly open: Promise<boolean> } | undefined;
  const mode = (): Promise<boolean> => {
    const at = now();
    // A clock that steps back counts as lapsed: the entry would otherwise outlive its 5 s.
    if (cached && at >= cached.at && at - cached.at < CACHE_MS) return cached.open;
    const open = pool
      .query("SELECT app.signup_open() AS open")
      .then((answer) => answer.rows[0]?.open === true);
    const entry = { at, open };
    cached = entry;
    // A failed read is never kept: the next request asks again.
    open.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return open;
  };
  defineRoute(app, {
    method: "get",
    path: "/api/v1/instance/signup",
    policy: "public",
    access: "none",
    handler: async () => ({ open: await mode() }),
  });
}
