import { liveSessionCookie } from "./cookie.js";
import { type Ctx, forward, type Handler, pass, respond, sessionAfter, text } from "./forward.js";
import { AUTH_BASE } from "./paths.js";
import { revokeOtherSessions } from "./sessions.js";

/** Every check of the session holder's password spends the account's login bucket and refunds it on success. */
const guarded =
  (inner: Handler): Handler =>
  async (ctx) => {
    const email = ctx.c.get("session").email.toLowerCase();
    await ctx.auth.throttle.spend("login_account", email);
    const answer = await inner(ctx);
    await ctx.auth.throttle.refundAccount(email);
    return answer;
  };

const verifyPassword = guarded(async (ctx) => {
  const answer = await pass(ctx);
  await ctx.auth.stepUp.record(ctx.c.get("session"), "password");
  return answer;
});

/** Enabling or disabling the second factor ends every session but the one that does it. */
const secondFactorChange = guarded(async (ctx) => {
  const { data, cookies } = await forward(ctx);
  const current = await sessionAfter(ctx, cookies);
  if (current) await revokeOtherSessions(ctx.auth, current);
  return respond(ctx.c, data, cookies);
});

/** A code of the second factor: completing a sign-in claims the owner place; a TOTP code proves identity again. */
const secondFactorCode =
  (recordsStepUp: boolean): Handler =>
  async (ctx: Ctx) => {
    const { data, cookies } = await forward(ctx);
    const session = await sessionAfter(ctx, cookies);
    if (session && recordsStepUp) await ctx.auth.stepUp.record(session, "totp");
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
  const outcome = await ctx.auth.passwords.screen(text(ctx, "newPassword"));
  // The token names the user; the library consumes it, so the user is read before.
  const context = await ctx.auth.library.$context;
  const token = await context.internalAdapter.findVerificationValue(`reset-password:${text(ctx, "token")}`);
  const answer = await pass(ctx);
  if (token) await ctx.auth.passwords.settle(token.value, outcome);
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
  [`POST ${AUTH_BASE}/two-factor/verify-totp`]: secondFactorCode(true),
  [`POST ${AUTH_BASE}/two-factor/verify-backup-code`]: secondFactorCode(false),
};
