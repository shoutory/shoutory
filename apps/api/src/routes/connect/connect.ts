import type { Context } from "hono";
import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import type { ConnectOutcome, ConnectService } from "../../channels/connect.js";
import type { SecretConnect } from "../../channels/secret-connect.js";
import { toRefusal } from "../../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../define-route.js";

// The callback is a browser navigation, so it answers a 302 to one fixed web path, never JSON. The start's bucket also
// caps the unspent flows.

const uuid = z.uuid().transform((id) => id.toLowerCase());
const providerId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
// A person types the host in any common form; the service reduces it to the one stored form or refuses it by name.
const typedHost = z.string().max(2048);

const RESULT_PATH = "/connect/result";

// A provider may add parameters (RFC 6749 section 4.1.2), so the callback is the one route besides the shell with a loose
// query: only these keys are read, each bounded, and a value that does not fit is read as absent, never as a 400.
const field = (max: number) => z.string().max(max).optional().catch(undefined);
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
  // The server built this redirect from the stored form, so anything else names no flow.
  instance_host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)
    .optional()
    .catch(undefined),
});

function registerStart(app: App, auth: AuthService, connect: ConnectService): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces/{workspace_id}/connect/{provider_id}/start",
    policy: "session",
    // Split: the registration of an app on an instance is an outbound call, which never runs inside a transaction.
    access: { workspace: "workspace_id", permission: "channels.manage", split: true },
    params: z.strictObject({ workspace_id: uuid, provider_id: providerId }),
    body: z.strictObject({
      instance_host: typedHost.optional(),
      channel_id: uuid.optional(),
      login_hint: z.string().min(1).max(512).optional(),
    }),
    handler: async ({ c, scoped, params, body }) => {
      await auth.throttle.spend("connect_start", c.get("session").userId);
      const authorizeUrl = await connect.start(scoped, {
        workspaceId: params.workspace_id,
        providerId: params.provider_id,
        instanceHost: body.instance_host,
        channelId: body.channel_id,
        loginHint: body.login_hint,
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

const SECRET_BASE = "/api/v1/workspaces/{workspace_id}/connect/{provider_id}";
const secretAccess = { workspace: "workspace_id", permission: "channels.manage", split: true } as const;
const workspaceProvider = { workspace_id: uuid, provider_id: providerId };
const challengeParams = z.strictObject({ ...workspaceProvider, challenge_id: uuid });
const wordSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[a-z0-9]+$/);

const callerOf = (
  auth: AuthService,
  c: Context<AppEnv>,
  params: { workspace_id: string; provider_id: string },
  ip: string,
) => ({
  workspaceId: params.workspace_id,
  providerId: params.provider_id,
  userId: c.get("session").userId,
  requestId: c.get("requestId"),
  ipHmac: auth.ipHmac(ip),
});

// The paste step: a webhook URL connects at once; a bot token waits on a challenge for the word typed into a chat.
function registerSecret(app: App, auth: AuthService, secrets: SecretConnect): void {
  defineRoute(app, {
    method: "post",
    path: `${SECRET_BASE}/secret`,
    policy: "session",
    access: secretAccess,
    params: z.strictObject(workspaceProvider),
    body: z.strictObject({ secret: z.string().min(1).max(2048), channel_id: uuid.optional() }),
    handler: async ({ c, scoped, params, body, clientAddress }) => {
      await auth.throttle.spend("connect_start", c.get("session").userId);
      const outcome = await secrets.paste(scoped, callerOf(auth, c, params, clientAddress), {
        secret: body.secret,
        channelId: body.channel_id,
      });
      if (outcome.kind === "connected") return { channel_id: outcome.channelId };
      return {
        challenge_id: outcome.challengeId,
        word: outcome.word,
        expires_at: outcome.expiresAt.toISOString(),
      };
    },
  });
}

// The wizard reads the challenge every 2 seconds, renews its word and, once a chat answered, completes it.
function registerChallenge(app: App, auth: AuthService, secrets: SecretConnect): void {
  defineRoute(app, {
    method: "get",
    path: `${SECRET_BASE}/challenge/{challenge_id}`,
    policy: "session",
    access: secretAccess,
    params: challengeParams,
    handler: async ({ scoped, params }) => {
      const found = await secrets.status(
        scoped,
        { workspaceId: params.workspace_id, providerId: params.provider_id },
        params.challenge_id,
      );
      return { state: found.state, chat_title: found.chatTitle };
    },
  });
  defineRoute(app, {
    method: "post",
    path: `${SECRET_BASE}/challenge/{challenge_id}/renew`,
    policy: "session",
    access: secretAccess,
    params: challengeParams,
    handler: async ({ c, scoped, params }) => {
      await auth.throttle.spend("connect_start", c.get("session").userId);
      const renewed = await secrets.renew(
        scoped,
        { workspaceId: params.workspace_id, providerId: params.provider_id },
        params.challenge_id,
      );
      return { word: renewed.word, expires_at: renewed.expiresAt.toISOString() };
    },
  });
  defineRoute(app, {
    method: "post",
    path: `${SECRET_BASE}/challenge/{challenge_id}/complete`,
    policy: "session",
    access: secretAccess,
    params: challengeParams,
    body: z.strictObject({ word: wordSchema }),
    handler: async ({ c, scoped, params, body, clientAddress }) => {
      // A split access checks the permission when the scope is first opened, and the completion opens none of its own.
      await scoped(false, async () => undefined);
      await auth.throttle.spend("connect_callback", c.get("session").userId);
      const channelId = await secrets.complete(
        callerOf(auth, c, params, clientAddress),
        params.challenge_id,
        body.word,
      );
      return { channel_id: channelId };
    },
  });
}

export function registerConnect(
  app: App,
  auth: AuthService,
  connect: ConnectService,
  secrets: SecretConnect,
): void {
  registerStart(app, auth, connect);
  registerCallback(app, auth, connect);
  registerSecret(app, auth, secrets);
  registerChallenge(app, auth, secrets);
}
