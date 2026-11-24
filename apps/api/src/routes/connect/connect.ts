import type { Context } from "hono";
import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import type { ConnectOutcome, ConnectService } from "../../channels/connect.js";
import { toRefusal } from "../../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../define-route.js";

// The OAuth connect routes. `start` is a workspace route for a member who can manage channels and answers
// the URL to send the person to. The callback is a browser navigation, so it answers a 302 to one fixed web path, never
// JSON: a reason code, or the new channel's id. Each call spends a per-user bucket first: the start's bucket also caps
// the unspent flows.

const uuid = z.uuid().transform((id) => id.toLowerCase());
const providerId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
// An instance host is a bare lower-case host name; the provider adapter decides what it may name.
const instanceHost = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);

// The fixed web path of every callback answer (the connect result screen of the web slice).
const RESULT_PATH = "/connect/result";

// A provider may add parameters (RFC 6749 section 4.1.2), so the callback is the one route besides the shell with a loose
// query: only these keys are read, each bounded, and a value that does not fit is read as absent, never as a 400.
const field = (max: number) => z.string().max(max).optional().catch(undefined);
// The state is the 43-character base64url form of 256 random bits; any other spelling is read as absent.
const state = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .optional()
  .catch(undefined);
const callbackQuery = z.object({
  code: field(2048),
  state,
  iss: field(512),
  error: field(128),
  error_description: field(1024),
  instance_host: instanceHost.optional().catch(undefined),
});

function registerStart(app: App, auth: AuthService, connect: ConnectService): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces/{workspace_id}/connect/{provider_id}/start",
    policy: "session",
    // Split: the registration of an app on an instance is an outbound call, which never runs inside a transaction.
    access: { workspace: "workspace_id", permission: "channels.manage", split: true },
    params: z.strictObject({ workspace_id: uuid, provider_id: providerId }),
    body: z.strictObject({ instance_host: instanceHost.optional(), channel_id: uuid.optional() }),
    handler: async ({ c, scoped, params, body }) => {
      await auth.throttle.spend("connect_start", c.get("session").userId);
      const authorizeUrl = await connect.start(scoped, {
        workspaceId: params.workspace_id,
        providerId: params.provider_id,
        instanceHost: body.instance_host,
        channelId: body.channel_id,
      });
      return { authorize_url: authorizeUrl };
    },
  });
}

// The exact keys of each outcome: `workspace` only when the flow was taken, and always the flow's own, never a value of
// the callback's query.
const paramsOf = (outcome: ConnectOutcome): Record<string, string> => {
  const workspace = outcome.workspaceId === undefined ? {} : { workspace: outcome.workspaceId };
  if (outcome.kind === "connected") return { channel: outcome.channelId, ...workspace };
  if (outcome.kind === "provider_error")
    return { reason: outcome.kind, message: outcome.message, ...workspace };
  if (outcome.kind === "wrong_account")
    return { reason: outcome.kind, channel: outcome.channelId, ...workspace };
  return { reason: outcome.kind, ...workspace };
};

// The answer of every callback: a 302 that is never cached, with the wait when a bucket refused.
function redirectTo(
  c: Context<AppEnv>,
  params: Record<string, string>,
  retryAfterSeconds?: number,
): Response {
  c.header("cache-control", "no-store");
  if (retryAfterSeconds !== undefined) c.header("retry-after", String(retryAfterSeconds));
  return c.redirect(`${RESULT_PATH}?${new URLSearchParams(params)}`, 302);
}

function registerCallback(app: App, auth: AuthService, connect: ConnectService): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/connect/{provider_id}/callback",
    // The session is read here, not by the policy: a callback with no session is a redirect to sign in, not a 401.
    policy: "public",
    access: "none",
    params: z.strictObject({ provider_id: providerId }),
    query: callbackQuery,
    looseQuery: true,
    handler: async ({ c, params, query, clientAddress }) => {
      const found = await auth.resolveSession(c.req.raw.headers);
      if (!found) return redirectTo(c, { reason: "sign_in" });
      try {
        await auth.throttle.spend("connect_callback", found.session.userId);
        const outcome = await connect.finish({
          userId: found.session.userId,
          providerId: params.provider_id,
          query,
          requestId: c.get("requestId"),
          ipHmac: auth.ipHmac(clientAddress),
        });
        return redirectTo(c, paramsOf(outcome));
      } catch (error) {
        const refusal = toRefusal(error);
        if (refusal.code === "too_many_requests") {
          return redirectTo(c, { reason: "rate_limited" }, refusal.retryAfterSeconds);
        }
        if (refusal.code === "service_unavailable") return redirectTo(c, { reason: "unavailable" });
        throw error;
      }
    },
  });
}

export function registerConnect(app: App, auth: AuthService, connect: ConnectService): void {
  registerStart(app, auth, connect);
  registerCallback(app, auth, connect);
}
