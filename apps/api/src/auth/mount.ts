import { Refusal } from "../errors/refusal.js";
import { type App, defineRoute } from "../routes/define-route.js";
import type { AuthService } from "./auth.js";
import { liveSessionCookie } from "./cookie.js";
import { CREDENTIAL_HANDLERS } from "./credential-handlers.js";
import { refusalFromLinkError } from "./error-map.js";
import {
  type Ctx,
  forward,
  type Handler,
  pass,
  respond,
  sessionAfter,
  text,
  userIdByEmail,
} from "./forward.js";
import { AUTH_BASE, AUTH_PATHS } from "./paths.js";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions.js";

const signUp: Handler = async (ctx) => {
  const email = text(ctx, "email").toLowerCase();
  await ctx.auth.throttle.spend("verification_resend", email);
  await ctx.auth.throttle.spendIp("verification_resend", ctx.ip);
  const outcome = await ctx.auth.passwords.screen(text(ctx, "password"));
  const answer = await pass(ctx);
  // An outage marks the new user for a re-check at the next sign-in. An existing email has no new password and
  // is marked as well: the extra check costs it nothing.
  const userId = outcome === "unavailable" ? await userIdByEmail(ctx, email) : undefined;
  if (userId) await ctx.auth.passwords.settle(userId, outcome);
  return answer;
};

const resend: Handler = async (ctx) => {
  const email = text(ctx, "email").toLowerCase();
  await ctx.auth.throttle.spend("verification_resend", email);
  await ctx.auth.throttle.spendIp("verification_resend", ctx.ip);
  return pass(ctx);
};

/** A locked or unknown account pays for one password hash too, so no answer or timing tells the three failures apart. */
async function refuseLocked(ctx: Ctx): Promise<never> {
  const context = await ctx.auth.library.$context;
  await context.password.hash(text(ctx, "password"));
  throw new Refusal("invalid_credentials", "the account bucket is empty");
}

/** A hit of the re-check ends the session the password step just made; the challenge cookie is never forwarded. */
async function refuseBreached(ctx: Ctx, cookies: readonly string[]): Promise<never> {
  if (liveSessionCookie(cookies)) {
    const created = await sessionAfter(ctx, cookies);
    if (created) await revokeSession(ctx.auth, created, created.id);
  }
  throw new Refusal("password_reset_required", "the password is in a breach list");
}

const signIn: Handler = async (ctx) => {
  const email = text(ctx, "email");
  await ctx.auth.throttle.spendIp("login_ip", ctx.ip);
  if (!(await ctx.auth.throttle.tryAccount(email))) return refuseLocked(ctx);
  const { data, cookies } = await forward(ctx);
  await ctx.auth.throttle.refundAccount(email);
  const userId = (data.user as { id: string } | undefined)?.id ?? (await userIdByEmail(ctx, email));
  if (userId && (await ctx.auth.passwords.recheckHit(userId, text(ctx, "password")))) {
    return refuseBreached(ctx, cookies);
  }
  // The second step of the challenge records the step-up and claims the owner place.
  if (data.twoFactorRedirect) return respond(ctx.c, data, cookies);
  const created = await sessionAfter(ctx, cookies);
  if (created) await ctx.auth.stepUp.record(created, "password");
  // The first verified user becomes owner; this repeats the claim of the verification hook, which a failure can skip.
  if (userId) await ctx.auth.claimOwner(userId);
  return respond(ctx.c, data, cookies);
};

const verifyEmail: Handler = async (ctx) => {
  await ctx.auth.throttle.spendIp("link_confirm", ctx.ip);
  try {
    // In process with no request: the library's origin check, which guards only its router, is not run.
    await ctx.auth.library.api.verifyEmail({ query: { token: text(ctx, "token") } });
  } catch (error) {
    throw refusalFromLinkError(error);
  }
  return respond(ctx.c, { data: { verified: true } }, []);
};

const getSession: Handler = async (ctx) => {
  const { id, userId, email, emailVerified, expiresAt } = ctx.c.get("session");
  return respond(
    ctx.c,
    { data: { session: { id, expiresAt }, user: { id: userId, email, emailVerified } } },
    [],
  );
};

const sessions: Handler = async (ctx) =>
  respond(ctx.c, { data: await listSessions(ctx.auth, ctx.c.get("session")) }, []);

const revoke: Handler = async (ctx) => {
  await revokeSession(ctx.auth, ctx.c.get("session"), text(ctx, "id"));
  return respond(ctx.c, { data: { revoked: true } }, []);
};

const revokeOthers: Handler = async (ctx) => {
  await revokeOtherSessions(ctx.auth, ctx.c.get("session"));
  return respond(ctx.c, { data: { revoked: true } }, []);
};

const HANDLERS: Readonly<Record<string, Handler>> = {
  ...CREDENTIAL_HANDLERS,
  [`POST ${AUTH_BASE}/sign-up/email`]: signUp,
  [`POST ${AUTH_BASE}/sign-in/email`]: signIn,
  [`POST ${AUTH_BASE}/sign-out`]: pass,
  [`POST ${AUTH_BASE}/send-verification-email`]: resend,
  [`POST ${AUTH_BASE}/verify-email`]: verifyEmail,
  [`GET ${AUTH_BASE}/get-session`]: getSession,
  [`GET ${AUTH_BASE}/sessions`]: sessions,
  [`POST ${AUTH_BASE}/sessions/revoke`]: revoke,
  [`POST ${AUTH_BASE}/sessions/revoke-others`]: revokeOthers,
};

/** Registers every `AUTH_PATHS` row through `defineRoute`: cookie only, strict body, its policy and its throttle. */
export function registerAuthRoutes(app: App, auth: AuthService): void {
  for (const row of AUTH_PATHS) {
    const handler = HANDLERS[`${row.method} ${row.path}`];
    if (!handler) throw new Error(`no handler for ${row.method} ${row.path}`);
    defineRoute(app, {
      method: row.method === "GET" ? "get" : "post",
      path: row.path,
      policy: row.policy,
      // The library handles these paths and reaches no workspace: a signed-in call runs as the user alone.
      access: row.policy === "public" ? "none" : "user",
      cookieOnly: true,
      ...(row.body ? { body: row.body } : {}),
      handler: ({ body, c, clientAddress }) =>
        handler({ auth, row, body: (body ?? {}) as Record<string, unknown>, c, ip: clientAddress }),
    });
  }
}
