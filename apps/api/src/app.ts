import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AuthService } from "./auth/auth.js";
import { registerAuthRoutes } from "./auth/mount.js";
import { errorResponse, Refusal, toRefusal } from "./errors/refusal.js";
import { registerHealth } from "./health/health.js";
import { type Logger, logRequest } from "./logging/logger.js";
import { type App, type AppEnv, initRoutes } from "./routes/define-route.js";
import { registerInvitations } from "./routes/invitations/invitations.js";
import { registerMembers } from "./routes/members/members.js";
import { registerOrganizations } from "./routes/organizations/organization.js";
import { registerWorkspaces } from "./routes/workspaces/workspace.js";
import { clientAddressResolver } from "./security/client-address.js";

export interface AppOptions {
  /** The exact origin the web app is served from; CSRF compares `Origin` with it. */
  readonly publicOrigin: string;
  /** CIDR ranges of the reverse proxies whose `X-Forwarded-For` is believed; empty trusts nobody. */
  readonly trustedProxies: readonly string[];
  readonly pool: AppPool;
  /** The key ring: `/readyz` is not ready while a sealed row names a key it does not hold. */
  readonly keys: KeyProvider;
  readonly logger: Logger;
  /** Sign-up, sign-in, sessions and the route policies that read them. */
  readonly auth: AuthService;
}

const SELF = ["'self'"];
const CSP = {
  defaultSrc: SELF,
  scriptSrc: SELF,
  styleSrc: SELF,
  imgSrc: ["'self'", "data:", "blob:"],
  connectSrc: SELF,
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: SELF,
  frameAncestors: ["'none'"],
};

/** Request id on every response, one request-log line per request. */
function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
    logRequest(logger.child({ requestId }), { method: c.req.method, url: c.req.url, status: c.res.status });
  };
}

/** The peer address comes from the socket; `X-Forwarded-For` counts only behind a trusted proxy. */
function clientContext(trusted: readonly string[]): MiddlewareHandler<AppEnv> {
  const resolve = clientAddressResolver(trusted);
  return async (c, next) => {
    const peer = getConnInfo(c).remote.address ?? "";
    c.set("clientAddress", resolve(peer, [c.req.header("x-forwarded-for") ?? ""]));
    await next();
  };
}

export function createApp(options: AppOptions): App {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        // Only the failing part is named: neither the Zod error nor any key or value the client sent.
        throw new Refusal("validation_failed", "input failed validation", {
          details: { target: result.target },
        });
      }
    },
  });
  initRoutes(app, options.publicOrigin, options.auth, options.pool);
  app.use("*", requestContext(options.logger));
  app.use("*", secureHeaders({ contentSecurityPolicy: CSP }));
  app.use("*", clientContext(options.trustedProxies));
  app.onError((error, c) => {
    const refusal = toRefusal(error);
    if (refusal.code === "internal_error" || refusal.code === "service_unavailable") {
      options.logger.error(
        { requestId: c.get("requestId"), code: refusal.code, err: error },
        "request failed",
      );
    }
    return errorResponse(c, refusal);
  });
  registerHealth(app, options.pool, options.keys);
  registerAuthRoutes(app, options.auth);
  registerOrganizations(app, options.auth.ipHmac);
  registerWorkspaces(app, options.auth.ipHmac);
  registerInvitations(app, options.auth);
  registerMembers(app, options.auth.ipHmac);
  app.notFound((c) => errorResponse(c, new Refusal("not_found", "no such route")));
  return app;
}
