import { queueAfterTransactionHook } from "@better-auth/core/context";
import type { SealedSecret } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool, AuthDb } from "@shoutory/db/pool";
import { authAccount, authSession, authTwoFactor, authUser, authVerification } from "@shoutory/db/schema";
import type { EgressRequest, EgressResponse } from "@shoutory/provider-sdk/egress";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { twoFactor } from "better-auth/plugins/two-factor";
import { Refusal } from "../errors/refusal.js";
import type { Logger } from "../logging/logger.js";
import { enqueueMail, type MailDeps, type MailInput } from "../mail/enqueue.js";
import { type MailLocale, requestLocale } from "../mail/templates.js";
import type { RouteAuth } from "../routes/define-route.js";
import { SESSION_COOKIE, TWO_FACTOR_COOKIE } from "./cookie.js";
import { createPasswordGuard, type PasswordGuard } from "./hibp.js";
import { DISABLED_PATHS } from "./paths.js";
import { readSession } from "./session-check.js";
import { digestSessionTokens } from "./session-token.js";
import { signupAllowed } from "./signup-gate.js";
import { createStepUp, type StepUp } from "./step-up.js";
import { createThrottle, type Throttle } from "./throttle.js";
import { secondFactorThrottle } from "./two-factor.js";

// The auth library reads the client address only from this header.
export const CLIENT_IP_HEADER = "x-shoutory-client-ip";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
const SCHEMA = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  twoFactor: authTwoFactor,
};
const ISSUER = "Shoutory";
// The policy counts code points (15 to 128); the library counts UTF-16 units, so its bound stays above ours.
const LIBRARY_MAX_PASSWORD = 256;

export interface AuthOptions {
  readonly publicOrigin: string;
  readonly secret: string;
  readonly pepper: SealedSecret;
  readonly keys: KeyProvider;
  readonly db: AuthDb;
  /** The `shoutory_auth` role: throttle buckets, the owner claim and the mail queue. */
  readonly pool: AppPool;
  /** The `shoutory_app` role: a user reads their own re-check mark through it. */
  readonly appPool: AppPool;
  readonly fetch: (request: EgressRequest) => Promise<EgressResponse>;
  readonly logger: Logger;
  readonly now?: () => number;
}

export type BetterAuthInstance = ReturnType<typeof createLibrary>;

export interface AuthService extends RouteAuth {
  readonly library: BetterAuthInstance;
  readonly publicOrigin: string;
  readonly throttle: Throttle;
  readonly mail: MailDeps;
  readonly stepUp: StepUp;
  readonly passwords: PasswordGuard;
  /** The first verified user becomes instance owner; the call is idempotent. */
  claimOwner(userId: string): Promise<void>;
  signupGate(email: string): Promise<boolean>;
  /**
   * The sign-up answer is the same open or closed, so a caller cannot learn which addresses exist; the mail goes
   * to the address owner instead.
   */
  notifySignupClosed(email: string, locale: MailLocale): Promise<void>;
  /** The keyed digest the audit log stores, never the address itself. */
  ipHmac(clientAddress: string): Buffer;
  now(): number;
  bucketKey(scope: string, subject: string): string;
  /** A failed write answers 503: an identity proof is never granted without its record. */
  audit(entry: AuditEntry): Promise<void>;
}

export interface AuditEntry {
  readonly action: "auth.sign_in" | "auth.step_up";
  readonly userId: string;
  readonly method: "password" | "totp" | "backup_code";
  readonly requestId: string;
  readonly clientAddress: string;
}

type QueuedMail = Omit<MailInput, "workspaceId" | "vars">;
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
  cookies: {
    session_token: { name: SESSION_COOKIE, attributes: COOKIE },
    two_factor: { name: TWO_FACTOR_COOKIE, attributes: COOKIE },
  },
  ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
} satisfies BetterAuthOptions["advanced"];

interface Effects {
  queue(mail: QueuedMail): Promise<void>;
  claimOwner(userId: string): Promise<void>;
  setLocale(userId: string, locale: MailLocale): Promise<void>;
}

type HookContext = { request?: Request | undefined; headers?: Headers | undefined } | null;

// The account row is written inside the library's transaction, so the profile row, which points at it, is written once
// that transaction has committed. The language is the one of the request that caused the account or the session.
const writeLocale = (effects: Effects, userId: string, context: HookContext): Promise<void> =>
  queueAfterTransactionHook(() =>
    effects.setLocale(userId, requestLocale(context?.request?.headers ?? context?.headers)),
  );

/**
 * The mail is queued after the sign-up's transaction commits: the queue then asks the pool for a connection while the
 * transaction no longer holds one, and a failing enqueue is rethrown out of the sign-up (the library otherwise
 * swallows a callback's error) instead of being answered as a success.
 */
const afterCommit = (queue: Effects["queue"], mail: QueuedMail): Promise<void> =>
  queueAfterTransactionHook(() => queue(mail));

// The token rides in the link's fragment, so it never reaches a server log. The library passes the request
// when one caused the mail; without one the mail is in English.
function mailOptions({ queue, claimOwner }: Effects, publicOrigin: string) {
  const pageLink = (path: string, token?: string): string =>
    `${publicOrigin}${path}${token ? `#token=${token}` : ""}`;
  return {
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      maxPasswordLength: LIBRARY_MAX_PASSWORD,
      onExistingUserSignUp: async ({ user }: { user: { email: string } }, request?: Request) =>
        afterCommit(queue, {
          recipient: user.email,
          template: "existing_account_notice",
          locale: requestLocale(request?.headers),
          link: pageLink("/auth/sign-in"),
        }),
      // No transaction here: the library swallows a failing callback and answers alike for any email.
      sendResetPassword: async (
        { user, token }: { user: { email: string }; token: string },
        request?: Request,
      ) =>
        queue({
          recipient: user.email,
          template: "reset_password",
          locale: requestLocale(request?.headers),
          link: pageLink("/auth/reset", token),
        }),
    },
    emailVerification: {
      sendVerificationEmail: async (
        { user, token }: { user: { email: string }; token: string },
        request?: Request,
      ) =>
        afterCommit(queue, {
          recipient: user.email,
          template: "verify_email",
          locale: requestLocale(request?.headers),
          link: pageLink("/auth/verify", token),
        }),
      // Runs after the committed update and never on a replay; sign-in claims again if this call fails.
      afterEmailVerification: async (user: { id: string }) => claimOwner(user.id),
    },
  };
}

function createLibrary(options: AuthOptions, effects: Effects, throttle: Throttle) {
  return betterAuth({
    baseURL: options.publicOrigin,
    secret: options.secret,
    trustedOrigins: [options.publicOrigin],
    database: digestSessionTokens(
      drizzleAdapter(options.db, { provider: "pg", schema: SCHEMA, transaction: true }),
    ),
    disabledPaths: [...DISABLED_PATHS],
    ...mailOptions(effects, options.publicOrigin),
    plugins: [twoFactor({ issuer: ISSUER, backupCodeOptions: { storeBackupCodes: "encrypted" } })],
    hooks: { before: secondFactorThrottle(throttle) },
    verification: { storeIdentifier: "hashed" },
    session: SESSION,
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    onAPIError: { throw: true },
    advanced: ADVANCED,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => (signupAllowed(user.email) ? undefined : false),
          after: async (user, context) => writeLocale(effects, user.id, context),
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ipAddress: session.ipAddress
                ? pepperDigest(options.pepper, "session_ip", session.ipAddress)
                : null,
            },
          }),
          // No profile call exists yet for a language switcher, so each sign-in writes the language.
          after: async (session, context) => writeLocale(effects, session.userId, context),
        },
      },
    },
    logger: {
      level: "warn",
      // The arguments are named so none shadows the log's own keys.
      log: (level, message, ...args) =>
        (level === "error" ? options.logger.error : options.logger.warn)({ args }, message),
    },
  });
}

export function createAuth(options: AuthOptions): AuthService {
  const deps = { keys: options.keys, pepper: options.pepper };
  const effects: Effects = {
    queue: async (mail) => {
      await enqueueMail(options.pool, { workspaceId: null, vars: {}, ...mail }, deps);
    },
    claimOwner: async (userId) => {
      await options.pool.query("SELECT app.instance_admin_claim($1)", [userId]);
    },
    setLocale: async (userId, locale) => {
      await options.pool.query("SELECT app.user_locale_set($1, $2)", [userId, locale]);
    },
  };
  const throttle = createThrottle(options.pool, options.pepper);
  const library = createLibrary(options, effects, throttle);
  const stepUp = createStepUp(options.pool);
  const now = options.now ?? Date.now;
  // Its own purpose keeps this digest apart from the `session_ip` one.
  const ipHmac = (address: string) => Buffer.from(pepperDigest(options.pepper, "audit_ip", address), "hex");
  return {
    library,
    publicOrigin: options.publicOrigin,
    throttle,
    mail: deps,
    stepUp,
    passwords: createPasswordGuard(options),
    resolveSession: (headers) => readSession(library, headers, now),
    requireStepUp: (session) => stepUp.require(session),
    claimOwner: effects.claimOwner,
    signupGate: async (email) => {
      const answer = await options.pool.query("SELECT app.signup_gate($1) AS open", [email]);
      return answer.rows[0]?.open === true;
    },
    notifySignupClosed: (email, locale) =>
      effects.queue({
        recipient: email,
        template: "signup_closed_notice",
        locale,
        link: `${options.publicOrigin}/auth/sign-in`,
      }),
    ipHmac,
    now,
    bucketKey: (scope, subject) => pepperDigest(options.pepper, scope, subject),
    audit: async ({ action, userId, method, requestId, clientAddress }) => {
      try {
        await options.pool.query("SELECT app.audit_insert_instance($1, 'user', $2, $3, $4, $5)", [
          action,
          userId,
          requestId,
          ipHmac(clientAddress),
          JSON.stringify({ method }),
        ]);
      } catch (error) {
        throw new Refusal("service_unavailable", "the audit write failed", {
          cause: error,
          details: { cause: "audit_unavailable" },
        });
      }
    },
  };
}
