import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import { CONNECTION_STATES, type ConnectionState } from "@shoutory/core/channels/state";
import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import type { HealthChecker, HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";
import { nameOf } from "../../names.js";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { pageAnswer, pageQuery } from "../input.js";

const uuid = z.uuid().transform((id) => id.toLowerCase());
const workspaceParams = z.strictObject({ workspace_id: uuid });
const channelParams = z.strictObject({ workspace_id: uuid, channel_id: uuid });
const rename = z.strictObject({ nickname: nameOf(200).nullable() });

// An allowlist of columns: no credential or provider secret is ever a field of the answer.
const ANSWER = `id, provider_id, account_kind, display_name, handle, nickname, avatar, connection_state, state_reason,
  health, health_checked_at, token_expires_at, reconnect_deadline, capability_epoch`;

// What the caller may do, said by the server so a screen never derives it. `reconnect` also needs a provider with a
// connect side (start refuses one without), and `check` a connected channel.
const ACTION = z.enum(["connect", "reconnect", "check"]);
type Action = z.infer<typeof ACTION>;
const connectionState = z.enum(CONNECTION_STATES);
const RECONNECTABLE: ReadonlySet<ConnectionState> = new Set([
  "needs_reconnect",
  "disconnected",
  "revoked_by_provider",
]);

interface Viewer {
  readonly canManage: boolean;
  readonly check: ChannelCheck | undefined;
}

const viewerOf = (scope: AuthorizedScope, check: ChannelCheck | undefined): Viewer => ({
  canManage: scope.permissions.has("channels.manage"),
  check,
});

// Own keys only: a provider id read from a row is never looked up on the prototype.
function registered(check: ChannelCheck | undefined, providerId: string): HealthProvider | undefined {
  return check && Object.hasOwn(check.providers, providerId) ? check.providers[providerId] : undefined;
}

const actionRow = z.object({ provider_id: z.string(), connection_state: connectionState });

function actionsOf(row: Record<string, unknown>, viewer: Viewer): Action[] {
  const { provider_id: providerId, connection_state: state } = actionRow.parse(row);
  const provider = registered(viewer.check, providerId);
  if (!viewer.canManage || !provider) return [];
  if (state === "connected") return [ACTION.enum.check];
  return RECONNECTABLE.has(state) && provider.adapter.connect ? [ACTION.enum.reconnect] : [];
}

const pageActionsOf = ({ canManage, check }: Viewer): Action[] =>
  canManage && Object.values(check?.providers ?? {}).some(({ adapter }) => adapter.connect !== undefined)
    ? [ACTION.enum.connect]
    : [];

async function read(tx: TenantTx, scope: AuthorizedScope, channelId: string, check?: ChannelCheck) {
  const found = await tx.query(`SELECT ${ANSWER} FROM app.channels WHERE workspace_id = $1 AND id = $2`, [
    scope.workspaceId,
    channelId,
  ]);
  const row = found.rows[0];
  if (!row) throw new Refusal("not_found", "channel row not visible");
  return { ...row, actions: actionsOf(row, viewerOf(scope, check)) };
}

type IpHmac = (address: string) => Buffer;

function registerReads(app: App, check?: ChannelCheck): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/channels",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.view" },
    params: workspaceParams,
    query: pageQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query(
        `SELECT ${ANSWER} FROM app.channels WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
         ORDER BY id LIMIT $3`,
        [scope.workspaceId, query.cursor ?? null, query.limit],
      );
      const viewer = viewerOf(scope, check);
      const rows = found.rows.map((row) => ({ ...row, actions: actionsOf(row, viewer) }));
      return pageAnswer(c, rows, query.limit, "id", { actions: pageActionsOf(viewer) });
    },
  });
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/channels/{channel_id}",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.view" },
    params: channelParams,
    handler: ({ tx, scope, params }) => read(tx, scope, params.channel_id, check),
  });
}

function registerRename(app: App, check?: ChannelCheck): void {
  defineRoute(app, {
    method: "patch",
    path: "/api/v1/workspaces/{workspace_id}/channels/{channel_id}",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.manage" },
    params: channelParams,
    body: rename,
    handler: async ({ tx, scope, params, body }) => {
      const found = await tx.query(
        "UPDATE app.channels SET nickname = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id",
        [scope.workspaceId, params.channel_id, body.nickname],
      );
      if (!found.rows[0]) throw new Refusal("not_found", "channel row not updated");
      return read(tx, scope, params.channel_id, check);
    },
  });
}

// The two definers, by fixed text: the path decides which one runs, never a value the client sent.
const MOVES = {
  disable: "SELECT app.channel_disable($1, $2, $3, $4)",
  enable: "SELECT app.channel_enable($1, $2, $3, $4)",
} as const;

function registerMoves(app: App, ipHmac: IpHmac, check?: ChannelCheck): void {
  for (const move of ["disable", "enable"] as const) {
    defineRoute(app, {
      method: "post",
      path: `/api/v1/workspaces/{workspace_id}/channels/{channel_id}/${move}`,
      policy: "session",
      access: { workspace: "workspace_id", permission: "channels.manage" },
      params: channelParams,
      handler: async ({ c, tx, scope, params, clientAddress }) => {
        try {
          await tx.query(MOVES[move], [
            scope.workspaceId,
            params.channel_id,
            c.get("requestId"),
            ipHmac(clientAddress),
          ]);
        } catch (error) {
          throw definerRefusal(error) ?? error;
        }
        return read(tx, scope, params.channel_id, check);
      },
    });
  }
}

// The time since the last check is read from the database clock.
const COOLDOWN_SECONDS = 60;
const STATE = `SELECT provider_id, connection_state,
  extract(epoch FROM clock_timestamp() - health_checked_at)::float8 AS since
  FROM app.channels WHERE workspace_id = $1 AND id = $2`;

// Short transactions around one provider read, none open while the provider answers.
function registerCheck(app: App, { checker, providers }: ChannelCheck): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces/{workspace_id}/channels/{channel_id}/check",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.manage", split: true },
    params: channelParams,
    handler: async ({ scoped, params }) => {
      const found = await scoped(false, async (tx, scope) => {
        const row = (
          await tx.query<{ provider_id: string; connection_state: string; since: number | null }>(STATE, [
            scope.workspaceId,
            params.channel_id,
          ])
        ).rows[0];
        if (!row) throw new Refusal("not_found", "channel row not visible");
        return { ...row, workspaceId: scope.workspaceId };
      });
      if (found.connection_state !== "connected") {
        throw new Refusal("conflict", "the channel is not connected", {
          details: { reason: "not_connected" },
        });
      }
      if (found.since !== null && found.since < COOLDOWN_SECONDS) {
        const retryAfterSeconds = Math.max(1, Math.ceil(COOLDOWN_SECONDS - found.since));
        throw new Refusal("too_many_requests", "the channel was checked a moment ago", { retryAfterSeconds });
      }
      // Own keys only: a provider id read from the row is never looked up on the prototype.
      const provider = Object.hasOwn(providers, found.provider_id) ? providers[found.provider_id] : undefined;
      if (!provider) {
        throw new Refusal("conflict", "no adapter for the provider", {
          details: { reason: "provider_unavailable" },
        });
      }
      const { health, snapshot } = await checker.observe(found.workspaceId, params.channel_id, provider);
      await scoped(true, (tx, scope) =>
        tx.query("SELECT app.channel_health_record($1, $2, $3, $4, $5, $6, $7, $8)", [
          scope.workspaceId,
          params.channel_id,
          health,
          snapshot.manifestDigest,
          snapshot.apiVersion,
          snapshot.sunsetAt,
          JSON.stringify(snapshot.capabilities),
          JSON.stringify(snapshot.limits),
        ]),
      );
      return scoped(false, (tx, scope) => read(tx, scope, params.channel_id, { checker, providers }));
    },
  });
}

export interface ChannelCheck {
  readonly checker: HealthChecker;
  readonly providers: Readonly<Record<string, HealthProvider>>;
}

export function registerChannels(app: App, ipHmac: IpHmac, check?: ChannelCheck): void {
  registerReads(app, check);
  registerRename(app, check);
  registerMoves(app, ipHmac, check);
  if (check) registerCheck(app, check);
}
