import { Refusal } from "../errors/refusal.js";
import { liveSessionCookie } from "./cookie.js";
import { audit, type Ctx, forward, type Handler, pass, respond, sessionAfter, text } from "./forward.js";
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
  const session = ctx.c.get("session");
  await audit(ctx, "auth.step_up", session.userId, "password");
  await ctx.auth.stepUp.record(session, "password");
  return answer;
});

/** Enabling or disabling the second factor ends every session but the one that does it. */
const secondFactorChange = guarded(async (ctx) => {
  const { data, cookies } = await forward(ctx);
  const current = await sessionAfter(ctx, cookies);
  if (current) await revokeOtherSessions(ctx.auth, current);
  return respond(ctx.c, data, cookies);
});

/**
 * A code is a sign-in when the request holds no live session, and then it completes the challenge; with a live session
 * the library lets that session win over a leftover challenge cookie, so a TOTP code only proves identity again.
 */
async function auditSecondFactor(
  ctx: Ctx,
  userId: string,
  method: "totp" | "backup_code",
  hadSession: boolean,
): Promise<void> {
  if (!hadSession) {
    await audit(ctx, "auth.sign_in", userId, method);
  } else if (method === "totp") {
    await audit(ctx, "auth.step_up", userId, "totp");
  }
}

/** A code of the second factor: completing a sign-in claims the owner place; a TOTP code proves identity again. */
const secondFactorCode =
  (method: "totp" | "backup_code"): Handler =>
  async (ctx: Ctx) => {
    const hadSession = (await ctx.auth.resolveSession(ctx.c.req.raw.headers)) !== null;
    const { data, cookies } = await forward(ctx);
    const session = await sessionAfter(ctx, cookies);
    if (session) await auditSecondFactor(ctx, session.userId, method, hadSession);
    if (session && method === "totp") await ctx.auth.stepUp.record(session, "totp");
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
