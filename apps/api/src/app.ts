import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { SealedSecret } from "@shoutory/core/crypto";
import { type Entitlements, entitlements as selfHost } from "@shoutory/core/entitlements";
import type { KeyProvider } from "@shoutory/core/keys";
import type { StorageDriver } from "@shoutory/core/storage";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AuthService } from "./auth/auth.js";
import { registerAuthRoutes } from "./auth/mount.js";
import { type ConnectService, createConnectService } from "./channels/connect.js";
import { createCredentialService } from "./channels/credentials.js";
import { createHealthChecker, type HealthProvider } from "./channels/health.js";
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
import { type ChannelCheck, registerChannels } from "./routes/channels/channels.js";
import { registerConnect } from "./routes/connect/connect.js";
import { type App, type AppEnv, initRoutes } from "./routes/define-route.js";
import { registerInstance } from "./routes/instance.js";
import { registerInvitations } from "./routes/invitations/invitations.js";
import type { ImportFetch } from "./routes/media/import.js";
import { registerMedia, sandboxDownloads } from "./routes/media/media.js";
import { registerMembers } from "./routes/members/members.js";
import { registerOperations } from "./routes/operations/operations.js";
import { registerOrganizations } from "./routes/organizations/organization.js";
import { registerPosts } from "./routes/posts/posts.js";
import { registerProviders } from "./routes/providers/providers.js";
import { registerUnsubscribe } from "./routes/unsubscribe.js";
import { registerEntitlements } from "./routes/workspaces/entitlements.js";
import { registerWorkspaces } from "./routes/workspaces/workspace.js";
import { clientAddressResolver } from "./security/client-address.js";
import { inlineScriptSource, readShell, registerStatic } from "./static/static.js";
import type { S3Multipart, S3Presigner } from "./storage/s3-driver.js";

export interface AppOptions {
  /** The exact origin the web app is served from; CSRF compares `Origin` with it. */
  readonly publicOrigin: string;
  /** CIDR ranges of the reverse proxies whose `X-Forwarded-For` is believed; empty trusts nobody. */
  readonly trustedProxies: readonly string[];
  readonly pool: AppPool;
  /** The key ring: `/readyz` is not ready while a sealed row names a key it does not hold. */
  readonly keys: KeyProvider;
  readonly logger: Logger;
  readonly auth: AuthService;
  readonly now?: () => number;
  readonly storage?: StorageDriver;
  /** Signs upload URLs (the S3 driver only); absent, the app has no register or complete routes for uploads. */
  readonly presigner?: S3Presigner;
  /** The server side of S3 multipart uploads (the S3 driver only); absent, a file above 64 MiB is refused. */
  readonly multipart?: S3Multipart;
  /** The egress fetch of the import of media by URL (a user URL under the operator policy); absent, there is no import route. */
  readonly mediaImportFetch?: ImportFetch;
  /** The most bytes one workspace may store; absent, no cap. */
  readonly mediaWorkspaceMaxBytes?: number | undefined;
  readonly webRoot?: string | undefined;
  readonly releaseChannel?: string;
  readonly mail?: MailSettings;
  readonly entitlements?: Entitlements;
  readonly channels?: {
    readonly providers: Readonly<Record<string, HealthProvider>>;
    readonly fetch: typeof fetch;
    /**
     * The egress client bound to the one instance host a channel stored, for a provider whose accounts live on
     * user-chosen servers; absent, every provider's calls use `fetch`.
     */
    readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
    readonly pepper: SealedSecret;
  };
}

function channelServices(options: AppOptions): { check: ChannelCheck; connect: ConnectService } | undefined {
  const { channels } = options;
  if (!channels) return undefined;
  const now = () => new Date();
  const { providers, pepper, fetchFor } = channels;
  const credentials = createCredentialService({
    pool: options.pool,
    keys: options.keys,
    pepper,
    fetch: channels.fetch,
    fetchFor,
    now,
    logger: options.logger,
    providers,
  });
  const checker = createHealthChecker({ credentials, now });
  const connect = createConnectService({
    pool: options.pool,
    keys: options.keys,
    fetch: channels.fetch,
    ...(fetchFor === undefined ? {} : { fetchFor }),
    now,
    publicOrigin: options.publicOrigin,
    providers,
    credentials,
    checker,
    logger: options.logger,
  });
  return { check: { checker, providers }, connect };
}

const SELF = ["'self'"];
// React Aria inserts two `<style>` elements with fixed text (a press and a scroll lock). The page allows exactly those
// texts by hash; the contract test recomputes both from the installed package, so an upgrade that changes one fails.
const INJECTED_STYLE_HASHES = [
  "'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='",
  "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='",
];
const cspFor = (scriptSources: string[]) => ({
  defaultSrc: SELF,
  scriptSrc: scriptSources,
  styleSrc: [...SELF, ...INJECTED_STYLE_HASHES],
  imgSrc: ["'self'", "data:", "blob:"],
  connectSrc: SELF,
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: SELF,
  frameAncestors: ["'none'"],
});

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

function registerAdminRoutes(app: App, options: AppOptions): void {
  registerAdmin(app, options.auth);
  registerAdminMe(app);
  registerQueue(app);
  registerSystem(app, options.pool, options.releaseChannel ?? "stable");
  registerMailChecks(app, options.auth, options.mail ?? { from: undefined, dkimSelector: undefined });
  if (options.storage) registerStorageCheck(app, options.auth, options.storage);
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
  initRoutes(app, options.publicOrigin, options.auth, options.pool, options.logger);
  app.use("*", requestContext(options.logger));
  sandboxDownloads(app); // before secureHeaders: it sets the page policy after the handler, this must come after it
  app.use("*", secureHeaders({ contentSecurityPolicy: cspFor(scriptSources) }));
  app.use("*", clientContext(options.trustedProxies));
  app.onError((error, c) => {
    const refusal = toRefusal(error);
    if (refusal.code === "internal_error" || refusal.code === "service_unavailable") {
      options.logger.error(
        { requestId: c.get("requestId"), code: refusal.code, details: refusal.details, err: error },
        "request failed",
      );
    }
    return errorResponse(c, refusal);
  });
  registerHealth(app, options.pool, options.keys);
  registerAuthRoutes(app, options.auth);
  registerOrganizations(app, options.auth);
  registerWorkspaces(app, options.auth);
  const channelRoutes = channelServices(options);
  registerChannels(app, options.auth.ipHmac, channelRoutes?.check);
  const providers = channelRoutes?.check.providers ?? {};
  registerPosts(app, providers, options);
  if (channelRoutes) registerConnect(app, options.auth, channelRoutes.connect);
  registerProviders(app, providers, options.publicOrigin);
  registerEntitlements(app, options.entitlements ?? selfHost);
  registerInvitations(app, options.auth);
  registerMembers(app, options.auth.ipHmac);
  registerOperations(app, options.auth.ipHmac);
  registerAudit(app);
  registerUnsubscribe(app, options.auth, options.pool);
  registerInstance(app, options.pool, options.now ?? Date.now);
  registerAdminRoutes(app, options);
  const { storage } = options;
  if (storage)
    registerMedia(app, { storage, providers }, options, () => new Date(options.now?.() ?? Date.now()));
  app.notFound((c) => errorResponse(c, new Refusal("not_found", "no such route")));
  // Last, so a route added before it is never shadowed by the shell.
  if (options.webRoot) registerStatic(app, options.webRoot, shell);
  return app;
}
