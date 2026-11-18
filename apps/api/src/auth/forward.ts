import type { Context } from "hono";
import type { AppEnv } from "../routes/define-route.js";
import { type AuditEntry, type AuthService, CLIENT_IP_HEADER } from "./auth.js";
import { authCookies, liveSessionCookie, withoutForgedSession } from "./cookie.js";
import { answerCode, refusalFromAnswer } from "./error-map.js";
import type { AuthPath } from "./paths.js";
import type { AuthSession } from "./session-check.js";

export interface Ctx {
  readonly auth: AuthService;
  readonly row: AuthPath;
  readonly body: Record<string, unknown>;
  readonly c: Context<AppEnv>;
  readonly ip: string;
}
export type Handler = (ctx: Ctx) => Promise<unknown>;

const NO_STORE = "no-store";
export const text = (ctx: Ctx, key: string): string => String(ctx.body[key]);

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
    ...(method === "POST" ? { body: JSON.stringify({ ...ctx.body, ...ctx.row.forced }) } : {}),
  });
}

export function respond(c: Context<AppEnv>, data: unknown, cookies: readonly string[]): Response {
  const response = c.json(data as object);
  response.headers.set("cache-control", NO_STORE);
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}

export interface Forwarded {
  readonly data: Record<string, unknown>;
  readonly cookies: string[];
}

/** One call through the library's own router; a failed answer becomes our envelope, a good one passes the allowlist. */
export async function forward(ctx: Ctx): Promise<Forwarded> {
  const answer = await ctx.auth.library.handler(libraryRequest(ctx));
  if (!answer.ok) throw refusalFromAnswer(answer.status, await answerCode(answer));
  const data = ctx.row.answer?.parse(await answer.json()) as Record<string, unknown>;
  return { data, cookies: authCookies(answer.headers) };
}

/**
 * The session an answer leaves the caller with: the one its live session cookie opens (a sign-in, or a second-factor
 * step that swaps the session), else the session the request already holds. Nothing for a challenge in progress.
 */
export async function sessionAfter(ctx: Ctx, cookies: readonly string[]): Promise<AuthSession | null> {
  const live = liveSessionCookie(cookies);
  const headers = live ? new Headers({ cookie: live.split(";")[0] ?? "" }) : ctx.c.req.raw.headers;
  return (await ctx.auth.resolveSession(headers))?.session ?? null;
}

export async function userIdByEmail(ctx: Ctx, email: string): Promise<string | undefined> {
  const context = await ctx.auth.library.$context;
  return (await context.internalAdapter.findUserByEmail(email))?.user.id;
}

/** The audit row of a sign-in or step-up of the user, with this request's id and client address. */
export const audit = (
  ctx: Ctx,
  action: AuditEntry["action"],
  userId: string,
  method: AuditEntry["method"],
): Promise<void> =>
  ctx.auth.audit({ action, userId, method, requestId: ctx.c.get("requestId"), clientAddress: ctx.ip });

export const pass = async (ctx: Ctx): Promise<Response> => {
  const { data, cookies } = await forward(ctx);
  return respond(ctx.c, data, cookies);
};
