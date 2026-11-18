import type { Context } from "hono";
import { Refusal } from "../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../routes/define-route.js";
import { type AuthService, CLIENT_IP_HEADER } from "./auth.js";
import { sessionCookies, withoutForgedSession } from "./cookie.js";
import { answerCode, refusalFromAnswer, refusalFromLinkError } from "./error-map.js";
import { AUTH_BASE, AUTH_PATHS, type AuthPath } from "./paths.js";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions.js";

interface Ctx {
  readonly auth: AuthService;
  readonly row: AuthPath;
  readonly body: Record<string, unknown>;
  readonly c: Context<AppEnv>;
  readonly ip: string;
}
type Handler = (ctx: Ctx) => Promise<unknown>;

const NO_STORE = "no-store";
const text = (ctx: Ctx, key: string): string => String(ctx.body[key]);

/**
 * The request the library sees is rebuilt from the validated body. The client's copy of the internal address header is
 * dropped and ours (the resolved client address) put in its place, and `Origin` is the public origin because our own
 * check has already accepted the request (the library's check stays as the second layer).
 */
function libraryRequest(ctx: Ctx): Request {
  const headers = new Headers(withoutForgedSession(ctx.c.req.raw.headers));
  headers.delete(CLIENT_IP_HEADER);
  headers.delete("content-length");
  headers.set(CLIENT_IP_HEADER, ctx.ip);
  headers.set("origin", ctx.auth.publicOrigin);
  headers.set("content-type", "application/json");
  const method = ctx.row.method;
  return new Request(ctx.c.req.url, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(ctx.body) } : {}),
  });
}

function respond(c: Context<AppEnv>, data: unknown, cookies: readonly string[]): Response {
  const response = c.json(data as object);
  response.headers.set("cache-control", NO_STORE);
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

interface Forwarded {
  readonly data: Record<string, unknown>;
  readonly cookies: string[];
}

/** One call through the library's own router; a failed answer becomes our envelope, a good one passes the allowlist. */
async function forward(ctx: Ctx): Promise<Forwarded> {
  const answer = await ctx.auth.library.handler(libraryRequest(ctx));
  if (!answer.ok) throw refusalFromAnswer(answer.status, await answerCode(answer));
  const data = ctx.row.answer?.parse(await answer.json()) as Record<string, unknown>;
  return { data, cookies: sessionCookies(answer.headers) };
}

const pass = async (ctx: Ctx): Promise<Response> => {
  const { data, cookies } = await forward(ctx);
  return respond(ctx.c, data, cookies);
};

const signUp: Handler = async (ctx) => {
  const email = text(ctx, "email").toLowerCase();
  await ctx.auth.throttle.spend("verification_resend", email);
  await ctx.auth.throttle.spendIp("verification_resend", ctx.ip);
  return pass(ctx);
};

const resend: Handler = signUp;

/** A locked or unknown account pays for one password hash too, so no answer or timing tells the three failures apart. */
async function refuseLocked(ctx: Ctx): Promise<never> {
  const context = await ctx.auth.library.$context;
  await context.password.hash(text(ctx, "password"));
  throw new Refusal("invalid_credentials", "the account bucket is empty");
}

const signIn: Handler = async (ctx) => {
  const email = text(ctx, "email");
  await ctx.auth.throttle.spendIp("login_ip", ctx.ip);
  if (!(await ctx.auth.throttle.tryAccount(email))) return refuseLocked(ctx);
  const { data, cookies } = await forward(ctx);
  await ctx.auth.throttle.refundAccount(email);
  // The first verified user becomes owner; this repeats the claim of the verification hook, which a failure can skip.
  await ctx.auth.claimOwner((data.user as { id: string }).id);
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
      cookieOnly: true,
      ...(row.body ? { body: row.body } : {}),
      handler: ({ body, c, clientAddress }) =>
        handler({ auth, row, body: (body ?? {}) as Record<string, unknown>, c, ip: clientAddress }),
    });
  }
}
