import type { MiddlewareHandler } from "hono";
import { Refusal } from "../errors/refusal.js";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const BEARER = /^Bearer\s+\S+$/i;

// Follows the OWASP CSRF cheat sheet and MDN Sec-Fetch-Site. A browser never sends a bearer credential on its own, so
// it is exempt.
export function csrf(publicOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || BEARER.test(c.req.header("authorization") ?? "")) return next();
    const site = c.req.header("sec-fetch-site");
    const sameOrigin =
      site === "same-origin" || (site === undefined && c.req.header("origin") === publicOrigin);
    if (!sameOrigin || c.req.header("x-shoutory-client") !== "web") {
      throw new Refusal("csrf_rejected", "the request is not from the web client of this origin");
    }
    return next();
  };
}
