import { passwordPolicy } from "@shoutory/core/password";
import { z } from "zod";
import { nameOf } from "../names.js";

export const AUTH_BASE = "/api/auth";

const email = z.email().max(320);
// A password that is only checked against the stored one (sign-in, confirmation) has a bound and no policy.
const password = z.string().min(1).max(128);
const userOut = z.object({ name: z.string(), email: z.string(), emailVerified: z.boolean() });
const status = z.object({ status: z.boolean() });
const personName = nameOf(100);
const code = z.string().regex(/^\d{6}$/);

type AuthPolicy = "public" | "session" | "step_up";

export interface AuthPath {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly policy: AuthPolicy;
  /** Our own handler: the library's route of this name (if any) is disabled and the library is called in process. */
  readonly ours: boolean;
  readonly body?: z.ZodType<Record<string, unknown>>;
  /** Allowlist of the library's 2xx answer: unknown keys, `token` among them, are dropped. */
  readonly answer?: z.ZodType<unknown>;
  readonly forced?: Readonly<Record<string, unknown>>;
}

const sessionOut = z.object({ user: userOut.extend({ id: z.string() }) });
const challengeOut = z.object({ twoFactorRedirect: z.literal(true) });
const confirm = z.strictObject({ password });

const post = (
  path: string,
  policy: AuthPolicy,
  body: AuthPath["body"],
  answer: AuthPath["answer"],
): AuthPath => ({
  method: "POST",
  path: `${AUTH_BASE}${path}`,
  policy,
  ours: false,
  ...(body ? { body } : {}),
  ...(answer ? { answer } : {}),
});

// The second factor: enrolment and its management need a recent step-up; the two checks of a code are public
// because a sign-in challenge has no session yet (our hook finds the user from the challenge cookie).
const SECOND_FACTOR_PATHS: readonly AuthPath[] = [
  post(
    "/two-factor/enable",
    "step_up",
    confirm,
    z.object({ method: z.literal("totp"), totpURI: z.string(), backupCodes: z.array(z.string()) }),
  ),
  post("/two-factor/disable", "step_up", confirm, status),
  post("/two-factor/get-totp-uri", "step_up", confirm, z.object({ totpURI: z.string() })),
  post(
    "/two-factor/generate-backup-codes",
    "step_up",
    confirm,
    z.object({ status: z.boolean(), backupCodes: z.array(z.string()) }),
  ),
  post("/two-factor/verify-totp", "public", z.strictObject({ code }), z.object({ user: userOut })),
  post(
    "/two-factor/verify-backup-code",
    "public",
    z.strictObject({ code: z.string().min(1).max(64) }),
    z.object({ user: userOut }),
  ),
];

const PASSWORD_PATHS: readonly AuthPath[] = [
  post("/verify-password", "session", confirm, status),
  {
    ...post(
      "/change-password",
      "step_up",
      z.strictObject({ currentPassword: password, newPassword: passwordPolicy }),
      z.object({ user: userOut }),
    ),
    forced: { revokeOtherSessions: true },
  },
  post("/request-password-reset", "public", z.strictObject({ email }), status),
  post(
    "/reset-password",
    "public",
    z.strictObject({ token: z.string().min(1).max(256), newPassword: passwordPolicy }),
    status,
  ),
];

export const AUTH_PATHS: readonly AuthPath[] = [
  {
    method: "POST",
    path: `${AUTH_BASE}/sign-up/email`,
    policy: "public",
    ours: false,
    body: z.strictObject({ name: personName, email, password: passwordPolicy }),
    answer: z.object({ user: userOut }),
  },
  {
    method: "POST",
    path: `${AUTH_BASE}/sign-in/email`,
    policy: "public",
    ours: false,
    body: z.strictObject({ email, password }),
    answer: z.union([sessionOut, challengeOut]),
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
  ...SECOND_FACTOR_PATHS,
  ...PASSWORD_PATHS,
  { method: "GET", path: `${AUTH_BASE}/get-session`, policy: "session", ours: true },
  {
    method: "POST",
    path: `${AUTH_BASE}/profile`,
    policy: "session",
    ours: true,
    body: z.strictObject({ name: personName }),
  },
  { method: "GET", path: `${AUTH_BASE}/two-factor/status`, policy: "session", ours: true },
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

// Every other path of the pinned library: it answers these with a plain 404 even if a request reaches it,
// and the app never forwards them.
export const DISABLED_PATHS: readonly string[] = [
  "/get-session",
  "/verify-email",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/sign-in/social",
  "/callback/:id",
  "/reset-password/:token",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
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
