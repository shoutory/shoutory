import { queueAfterTransactionHook } from "@better-auth/core/context";
import type { SealedSecret } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool, AuthDb } from "@shoutory/db/pool";
import { authAccount, authSession, authUser, authVerification } from "@shoutory/db/schema";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import type { Logger } from "../logging/logger.js";
import { enqueueMail, type MailInput } from "../mail/enqueue.js";
import type { RouteAuth } from "../routes/define-route.js";
import { SESSION_COOKIE } from "./cookie.js";
import { DISABLED_PATHS } from "./paths.js";
import { readSession } from "./session-check.js";
import { digestSessionTokens } from "./session-token.js";
import { createThrottle, pepperDigest, type Throttle } from "./throttle.js";

/** The header our mount sets from the resolved client address; the library reads the session address only from it. */
export const CLIENT_IP_HEADER = "x-shoutory-client-ip";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
// The model keys are the library's; the tables are ours.
const SCHEMA = { user: authUser, session: authSession, account: authAccount, verification: authVerification };

export interface AuthOptions {
  readonly publicOrigin: string;
  /** `SHOUTORY_SESSION_SECRET`. */
  readonly secret: string;
  readonly pepper: SealedSecret;
  readonly keys: KeyProvider;
  readonly db: AuthDb;
  /** The pool of the `shoutory_auth` role: throttle buckets, the owner claim and the mail queue. */
  readonly pool: AppPool;
  readonly logger: Logger;
}

export type BetterAuthInstance = ReturnType<typeof createLibrary>;

/** What the mount and the route policies use: the library, our throttle and the session reader. */
export interface AuthService extends RouteAuth {
  readonly library: BetterAuthInstance;
  readonly publicOrigin: string;
  readonly throttle: Throttle;
  /** The first verified user becomes instance owner; the call is idempotent (a no-op once any admin exists). */
  claimOwner(userId: string): Promise<void>;
}

type QueuedMail = Omit<MailInput, "workspaceId" | "locale" | "vars">;
const SESSION = {
  expiresIn: SESSION_SECONDS,
  updateAge: SESSION_REFRESH_SECONDS,
  cookieCache: { enabled: false },
  // The Drizzle key of the column `ip_hmac`: the adapter resolves a field through the table's keys.
  fields: { ipAddress: "ipHmac" },
} satisfies BetterAuthOptions["session"];

const COOKIE = { secure: true, path: "/", httpOnly: true, sameSite: "lax" } as const;
const ADVANCED = {
  // The id column has a database default; the library omits the id and reads the row back with RETURNING.
  database: { generateId: false },
  // Never `true`: with it (or an https base URL) the library prefixes `__Secure-` in front of `__Host-`.
  useSecureCookies: false,
  disableOriginCheck: false,
  disableCSRFCheck: false,
  defaultCookieAttributes: COOKIE,
  cookies: { session_token: { name: SESSION_COOKIE, attributes: COOKIE } },
  ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
} satisfies BetterAuthOptions["advanced"];

interface Effects {
  queue(mail: QueuedMail): Promise<void>;
  claimOwner(userId: string): Promise<void>;
}

/**
 * The mail is queued after the sign-up's transaction commits: the queue then asks the pool for a connection while the
 * transaction no longer holds one, and a failing enqueue is rethrown out of the sign-up (the library otherwise
 * swallows a callback's error) instead of being answered as a success.
 */
const afterCommit = (queue: Effects["queue"], mail: QueuedMail): Promise<void> =>
  queueAfterTransactionHook(() => queue(mail));

function createLibrary(options: AuthOptions, { queue, claimOwner }: Effects) {
  const pageLink = (path: string, token?: string): string =>
    `${options.publicOrigin}${path}${token ? `#token=${token}` : ""}`;
  return betterAuth({
    baseURL: options.publicOrigin,
    secret: options.secret,
    trustedOrigins: [options.publicOrigin],
    database: digestSessionTokens(
      drizzleAdapter(options.db, { provider: "pg", schema: SCHEMA, transaction: true }),
    ),
    // Every `/api/auth` path that is not a mount row answers the envelope's 404 before the library sees it.
    disabledPaths: [...DISABLED_PATHS],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: async ({ user }) =>
        afterCommit(queue, {
          recipient: user.email,
          template: "existing_account_notice",
          link: pageLink("/auth/sign-in"),
        }),
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, token }) =>
        afterCommit(queue, {
          recipient: user.email,
          template: "verify_email",
          link: pageLink("/auth/verify", token),
        }),
      // Runs after the committed update and never on a replay; sign-in claims again if this call fails.
      afterEmailVerification: async (user) => claimOwner(user.id),
    },
    verification: { storeIdentifier: "hashed" },
    session: SESSION,
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    onAPIError: { throw: true },
    advanced: ADVANCED,
    databaseHooks: {
      session: {
        create: {
          // The column holds the keyed digest of the client address, never the address.
          before: async (session) => ({
            data: {
              ipAddress: session.ipAddress
                ? pepperDigest(options.pepper, "session_ip", session.ipAddress)
                : null,
            },
          }),
        },
      },
    },
    logger: {
      level: "warn",
      // The library's level is kept: a warn stays a warn. The arguments are named so none shadows the log's own keys.
      log: (level, message, ...args) =>
        (level === "error" ? options.logger.error : options.logger.warn)({ args }, message),
    },
  });
}

/** Builds the authentication service over the `shoutory_auth` pool. */
export function createAuth(options: AuthOptions): AuthService {
  const deps = { keys: options.keys, pepper: options.pepper };
  const effects: Effects = {
    queue: async (mail) => {
      await enqueueMail(options.pool, { workspaceId: null, locale: "en", vars: {}, ...mail }, deps);
    },
    claimOwner: async (userId) => {
      await options.pool.query("SELECT app.instance_admin_claim($1)", [userId]);
    },
  };
  const library = createLibrary(options, effects);
  return {
    library,
    publicOrigin: options.publicOrigin,
    throttle: createThrottle(options.pool, options.pepper),
    resolveSession: (headers) => readSession(library, headers),
    claimOwner: effects.claimOwner,
  };
}
