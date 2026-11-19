import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono } from "@hono/zod-openapi";
import { type Entitlements, entitlements as selfHost } from "@shoutory/core/entitlements";
import type { KeyProvider } from "@shoutory/core/keys";
import type { StorageDriver } from "@shoutory/core/storage";
import type { AppPool } from "@shoutory/db/pool";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AuthService } from "./auth/auth.js";
import { registerAuthRoutes } from "./auth/mount.js";
import { errorResponse, Refusal, toRefusal } from "./errors/refusal.js";
import { registerHealth } from "./health/health.js";
import { type Logger, logRequest } from "./logging/logger.js";
import { registerAdmin } from "./routes/admin/admin.js";
import { type MailSettings, registerMailChecks } from "./routes/admin/mail.js";
import { registerAdminMe } from "./routes/admin/me.js";
import { registerQueue } from "./routes/admin/queue.js";
import { registerStorageCheck } from "./routes/admin/storage-check.js";
import { registerSystem } from "./routes/admin/system.js";
import { registerAudit } from "./routes/audit/audit.js";
import { type App, type AppEnv, initRoutes } from "./routes/define-route.js";
import { registerInstance } from "./routes/instance.js";
import { registerInvitations } from "./routes/invitations/invitations.js";
import { registerMembers } from "./routes/members/members.js";
import { registerOrganizations } from "./routes/organizations/organization.js";
import { registerUnsubscribe } from "./routes/unsubscribe.js";
import { registerEntitlements } from "./routes/workspaces/entitlements.js";
import { registerWorkspaces } from "./routes/workspaces/workspace.js";
import { clientAddressResolver } from "./security/client-address.js";
import { inlineScriptSource, readShell, registerStatic } from "./static/static.js";

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
  /** The clock of the in-process caches, in milliseconds; the system clock when absent. */
  readonly now?: () => number;
  /** Where objects are stored; the storage routes exist only when it is given. */
  readonly storage?: StorageDriver;
  /** The folder of the built web app; when set, the app serves it after every other route. */
  readonly webRoot?: string | undefined;
  /** The release channel of this build (`stable`, `beta`, `nightly`); `stable` when absent. */
  readonly releaseChannel?: string;
  /** The sender the admin mail check reads; absent, the check finds no domain and looks nothing up. */
  readonly mail?: MailSettings;
  /** The plan limits of a workspace; the self-host answer (nothing is limited) when absent. */
  readonly entitlements?: Entitlements;
}

const SELF = ["'self'"];
const cspFor = (scriptSources: string[]) => ({
  defaultSrc: SELF,
  scriptSrc: scriptSources,
  styleSrc: SELF,
  imgSrc: ["'self'", "data:", "blob:"],
  connectSrc: SELF,
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: SELF,
  frameAncestors: ["'none'"],
});

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
  // Read once, first: a shell that cannot be hashed refuses the start, and the copy hashed here is the one served.
  const shell = options.webRoot ? readShell(options.webRoot) : undefined;
  const scriptSources = shell === undefined ? SELF : [...SELF, inlineScriptSource(shell)];
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
  app.use("*", secureHeaders({ contentSecurityPolicy: cspFor(scriptSources) }));
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
  registerEntitlements(app, options.entitlements ?? selfHost);
  registerInvitations(app, options.auth);
  registerMembers(app, options.auth.ipHmac);
  registerAudit(app);
  registerUnsubscribe(app, options.auth, options.pool);
  registerInstance(app, options.pool, options.now ?? Date.now);
  registerAdmin(app, options.auth);
  registerAdminMe(app);
  registerQueue(app);
  registerSystem(app, options.pool, options.releaseChannel ?? "stable");
  registerMailChecks(app, options.auth, options.mail ?? { from: undefined, dkimSelector: undefined });
  if (options.storage) registerStorageCheck(app, options.auth, options.storage);
  app.notFound((c) => errorResponse(c, new Refusal("not_found", "no such route")));
  // Last, so a route added before it is never shadowed by the shell (R360).
  if (options.webRoot) registerStatic(app, options.webRoot, shell);
  return app;
}
