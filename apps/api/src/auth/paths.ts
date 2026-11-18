import { z } from "zod";

export const AUTH_BASE = "/api/auth";

const email = z.email().max(320);
// The library enforces its own 8..128 length; the policy and breach check are the second-factor slice's.
const password = z.string().min(1).max(128);
const userOut = z.object({ name: z.string(), email: z.string(), emailVerified: z.boolean() });

type AuthPolicy = "public" | "session";

export interface AuthPath {
  readonly method: "GET" | "POST";
  /** The mounted path, with the base. */
  readonly path: string;
  readonly policy: AuthPolicy;
  /** Our own handler: the library's route of this name (if any) is disabled and the library is called in process. */
  readonly ours: boolean;
  /** Strict body of a POST. */
  readonly body?: z.ZodType<Record<string, unknown>>;
  /** Allowlist of the library's 2xx answer: unknown keys, `token` among them, are dropped. */
  readonly answer?: z.ZodType<unknown>;
}

const sessionOut = z.object({ user: userOut.extend({ id: z.string() }) });

/** Every route the mount registers. A path of the library that is not here is in `DISABLED_PATHS`. */
export const AUTH_PATHS: readonly AuthPath[] = [
  {
    method: "POST",
    path: `${AUTH_BASE}/sign-up/email`,
    policy: "public",
    ours: false,
    body: z.strictObject({ name: z.string().min(1).max(100), email, password }),
    answer: z.object({ user: userOut }),
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/sign-in/email`,
    policy: "public",
    ours: false,
    body: z.strictObject({ email, password }),
    answer: sessionOut,
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/sign-out`,
    policy: "session",
    ours: false,
    body: z.strictObject({}),
    answer: z.object({ success: z.boolean() }),
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/send-verification-email`,
    policy: "public",
    ours: false,
    body: z.strictObject({ email }),
    answer: z.object({ status: z.boolean() }),
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/verify-email`,
    policy: "public",
    ours: true,
    body: z.strictObject({ token: z.string().min(1).max(2048) }),
  },
  { method: "GET", path: `${AUTH_BASE}/get-session`, policy: "session", ours: true },
  { method: "GET", path: `${AUTH_BASE}/sessions`, policy: "session", ours: true },
  {
    method: "POST",
    path: `${AUTH_BASE}/sessions/revoke`,
    policy: "session",
    ours: true,
    body: z.strictObject({ id: z.uuid() }),
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/sessions/revoke-others`,
    policy: "session",
    ours: true,
    body: z.strictObject({}),
  },
];

/**
 * Every other path of the pinned library (1.7.16), by its name under the base path. The library answers these with a
 * plain 404 even if a request reaches it; the app never forwards them. The second-factor slice moves its rows out.
 */
export const DISABLED_PATHS: readonly string[] = [
  "/get-session",
  "/verify-email",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/sign-in/social",
  "/callback/:id",
  "/request-password-reset",
  "/reset-password/:token",
  "/reset-password",
  "/verify-password",
  "/change-password",
  "/change-email",
  "/update-user",
  "/update-session",
  "/delete-user",
  "/delete-user/callback",
  "/list-accounts",
  "/link-social",
  "/unlink-account",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  "/ok",
  "/error",
];
