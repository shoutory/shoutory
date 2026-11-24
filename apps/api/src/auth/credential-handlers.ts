import { Refusal } from "../errors/refusal.js";
import { liveSessionCookie } from "./cookie.js";
import { audit, type Ctx, forward, type Handler, pass, respond, sessionAfter, text } from "./forward.js";
import { AUTH_BASE } from "./paths.js";
import { revokeOtherSessions } from "./sessions.js";

/**
 * Every check of the session holder's password spends a login bucket keyed by the user id and refunds it on success.
 * The sign-in bucket is keyed by the address, so an anonymous caller emptying it cannot refuse a signed-in user.
 */
const guarded =
  (inner: Handler): Handler =>
  async (ctx) => {
    const { userId } = ctx.c.get("session");
    await ctx.auth.throttle.spend("login_account", userId);
    const answer = await inner(ctx);
    await ctx.auth.throttle.refundAccount(userId);
    return answer;
  };

const verifyPassword = guarded(async (ctx) => {
  const answer = await pass(ctx);
  const session = ctx.c.get("session");
  await audit(ctx, "auth.step_up", session.userId, "password");
  await ctx.auth.stepUp.record(session, "password");
  return answer;
});

const secondFactorChange = guarded(async (ctx) => {
  const { data, cookies } = await forward(ctx);
  const current = await sessionAfter(ctx, cookies);
  if (current) await revokeOtherSessions(ctx.auth, current);
  return respond(ctx.c, data, cookies);
});

/**
 * A code of the second factor. With no live session it is a sign-in: it completes the challenge and claims the owner
 * place. With a live session the library lets that session win over a leftover challenge cookie, so the code (a TOTP
 * or a backup code) only proves identity again. Either way the audit row comes first, then the step-up record: a
 * backup-code sign-in records `backup_code` as a TOTP sign-in records `totp`, so a person without the device can still
 * step up.
 */
const secondFactorCode =
  (method: "totp" | "backup_code"): Handler =>
  async (ctx: Ctx) => {
    const before = (await ctx.auth.resolveSession(ctx.c.req.raw.headers))?.session ?? null;
    const hadSession = before !== null;
    const { data, cookies } = await forward(ctx);
    const session = await sessionAfter(ctx, cookies);
    // The first code activates the second factor and swaps the session: every other one, one opened while the
    // secret was being set up included, ends with the old one (a privilege change renews the sessions).
    if (session && method === "totp" && before && !before.twoFactorEnabled) {
      await revokeOtherSessions(ctx.auth, session);
    }
    if (session) {
      await audit(ctx, hadSession ? "auth.step_up" : "auth.sign_in", session.userId, method);
      await ctx.auth.stepUp.record(session, method);
    }
    if (session && liveSessionCookie(cookies)) await ctx.auth.claimOwner(session.userId);
    return respond(ctx.c, data, cookies);
  };

const changePassword = guarded(async (ctx) => {
  const outcome = await ctx.auth.passwords.screen(text(ctx, "newPassword"));
  const answer = await pass(ctx);
  await ctx.auth.passwords.settle(ctx.c.get("session").userId, outcome);
  return answer;
});

/** One answer for a known and an unknown email: both spend the same buckets and the library answers alike. */
const requestReset: Handler = async (ctx) => {
  await ctx.auth.throttle.spend("password_reset", text(ctx, "email").toLowerCase());
  await ctx.auth.throttle.spendIp("password_reset", ctx.ip);
  return pass(ctx);
};

const resetPassword: Handler = async (ctx) => {
  await ctx.auth.throttle.spendIp("link_confirm", ctx.ip);
  // The token is looked up first: a link that is unknown, used or expired is `link_unusable` whatever the new
  // password is, never reported as a refused password. It names the user, and the library consumes it, so the user is
  // read here too.
  const context = await ctx.auth.library.$context;
  const token = await context.internalAdapter.findVerificationValue(`reset-password:${text(ctx, "token")}`);
  if (!token || token.expiresAt < new Date())
    throw new Refusal("link_unusable", "the reset link is unusable");
  const outcome = await ctx.auth.passwords.screen(text(ctx, "newPassword"));
  const answer = await pass(ctx);
  await ctx.auth.passwords.settle(token.value, outcome);
  // A completed recovery unlocks the address, as the sign-in bucket's lockout would otherwise outlast it.
  const user = await context.internalAdapter.findUserById(token.value);
  if (user) await ctx.auth.throttle.refundAccount(user.email);
  return answer;
};

export const CREDENTIAL_HANDLERS: Readonly<Record<string, Handler>> = {
  [`POST ${AUTH_BASE}/verify-password`]: verifyPassword,
  [`POST ${AUTH_BASE}/change-password`]: changePassword,
  [`POST ${AUTH_BASE}/request-password-reset`]: requestReset,
  [`POST ${AUTH_BASE}/reset-password`]: resetPassword,
  [`POST ${AUTH_BASE}/two-factor/enable`]: secondFactorChange,
  [`POST ${AUTH_BASE}/two-factor/disable`]: secondFactorChange,
  [`POST ${AUTH_BASE}/two-factor/get-totp-uri`]: guarded(pass),
  [`POST ${AUTH_BASE}/two-factor/generate-backup-codes`]: guarded(pass),
  [`POST ${AUTH_BASE}/two-factor/verify-totp`]: secondFactorCode("totp"),
  [`POST ${AUTH_BASE}/two-factor/verify-backup-code`]: secondFactorCode("backup_code"),
};
