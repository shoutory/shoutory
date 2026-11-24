import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Throttle } from "./throttle.js";

const TOTP_PATH = "/two-factor/verify-totp";
const BACKUP_PATH = "/two-factor/verify-backup-code";

async function challengedUser(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const session = await getSessionFromCtx(ctx, { disableRefresh: true });
  if (session) return session.user.id;
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return undefined;
  return (await ctx.context.internalAdapter.findVerificationValue(identifier))?.value;
}

/**
 * Before the plugin looks at a code: one `two_factor` token per attempt for the user, and for a TOTP code one
 * `totp_code` token for the user and the code, so a code is accepted once (RFC 6238 5.2). A wrong guess spends only
 * its own code's bucket. A request that names no user is left to the plugin, which refuses it.
 */
export const secondFactorThrottle = (throttle: Throttle) =>
  createAuthMiddleware(async (ctx) => {
    if (ctx.path !== TOTP_PATH && ctx.path !== BACKUP_PATH) return;
    const userId = await challengedUser(ctx);
    if (!userId) return;
    await throttle.spend("two_factor", userId);
    if (ctx.path === TOTP_PATH) await throttle.spend("totp_code", `${userId}:${String(ctx.body?.code)}`);
  });
