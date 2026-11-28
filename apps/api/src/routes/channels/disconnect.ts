import { impactOf, LIST_BOUND, type OperationRow } from "@shoutory/core/channels/disconnect";
import { withAdvisoryLock } from "@shoutory/db/locks";
import { z } from "zod";
import type { CredentialService } from "../../channels/credentials.js";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { requireIdempotencyKey } from "../idempotency-key.js";

const uuid = z.uuid().transform((id) => id.toLowerCase());
const channelParams = z.strictObject({ workspace_id: uuid, channel_id: uuid });
const BASE = "/api/v1/workspaces/{workspace_id}/channels/{channel_id}";

export interface DisconnectDeps {
  readonly credentials: CredentialService;
  readonly providers: Readonly<Record<string, HealthProvider>>;
}

const channelOf = z.object({ provider_id: z.string() });

// Own keys only: a provider id read from a row is never looked up on the prototype.
const providerOf = (deps: DisconnectDeps, id: string) =>
  Object.hasOwn(deps.providers, id) ? deps.providers[id] : undefined;

// The operations that are neither finished nor only waiting for the channel: the core rules say which of them block.
// One more than the bound is read, so a list that holds more says so.
const OPEN_OPERATIONS = `SELECT o.id, o.state, v.post_id AS "postId", coalesce(c.nickname, c.display_name) AS "channelName"
  FROM app.operations AS o
  JOIN app.post_variants AS v ON v.workspace_id = o.workspace_id AND v.id = o.variant_id
  JOIN app.channels AS c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id
  WHERE o.workspace_id = $1 AND o.channel_id = $2 AND ($3::uuid[] IS NULL OR o.id = ANY ($3::uuid[]))
    AND o.state NOT IN ('published', 'failed', 'cancelled', 'missed', 'superseded_after_unknown_outcome',
      'pending', 'retry_wait', 'paused', 'blocked_reconnect')
  ORDER BY o.id LIMIT ${LIST_BOUND + 1}`;

function registerImpact(app: App, deps: DisconnectDeps | undefined): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/disconnect-impact`,
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.manage" },
    params: channelParams,
    handler: async ({ tx, scope, params }) => {
      const channel = await tx.query(
        "SELECT provider_id FROM app.channels WHERE workspace_id = $1 AND id = $2",
        [scope.workspaceId, params.channel_id],
      );
      const found = channelOf.safeParse(channel.rows[0]);
      if (!found.success) throw new Refusal("not_found", "channel row not visible");
      const scheduled = await tx.query<{ variantId: string; postId: string; dueAt: Date | null }>(
        `SELECT v.id AS "variantId", v.post_id AS "postId", v.due_at AS "dueAt" FROM app.post_variants AS v
         WHERE v.workspace_id = $1 AND v.channel_id = $2
           AND (v.schedule_state IN ('scheduled', 'held')
             OR (v.schedule_state = 'in_progress' AND EXISTS (SELECT 1 FROM app.operations AS o
               WHERE o.workspace_id = v.workspace_id AND o.variant_id = v.id
                 AND o.state IN ('pending', 'retry_wait', 'paused', 'blocked_reconnect'))))
         ORDER BY v.id LIMIT ${LIST_BOUND + 1}`,
        [scope.workspaceId, params.channel_id],
      );
      const operations = await tx.query<OperationRow>(OPEN_OPERATIONS, [
        scope.workspaceId,
        params.channel_id,
        null,
      ]);
      const provider = deps ? providerOf(deps, found.data.provider_id) : undefined;
      return {
        ...impactOf(
          scheduled.rows.map((row) => ({
            ...row,
            dueAt: row.dueAt === null ? null : new Date(row.dueAt).toISOString(),
          })),
          operations.rows,
        ),
        revokeSupported: provider?.adapter.revoke !== undefined,
      };
    },
  });
}

type IpHmac = (address: string) => Buffer;

// Transaction 1 takes the channel lock first, then the definer refuses or disconnects; the provider is called with no
// transaction open; transaction 2 overwrites the secret bytes. A failed revoke never stops the destroy.
function registerDisconnect(app: App, ipHmac: IpHmac, deps: DisconnectDeps): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/disconnect`,
    policy: "step_up",
    access: { workspace: "workspace_id", permission: "channels.manage", split: true },
    params: channelParams,
    handler: async ({ c, scoped, params, clientAddress }) => {
      requireIdempotencyKey(c);
      const first = await scoped(true, (tx, scope) =>
        withAdvisoryLock(
          tx,
          "channel",
          async () => {
            const found = await tx
              .query<{ blocking: string[] }>("SELECT app.channel_disconnect($1, $2, $3, $4) AS blocking", [
                scope.workspaceId,
                params.channel_id,
                c.get("requestId"),
                ipHmac(clientAddress),
              ])
              .catch((error: unknown) => {
                throw definerRefusal(error) ?? error;
              });
            const blocking = found.rows[0]?.blocking ?? [];
            if (blocking.length > 0) {
              const named = await tx.query<OperationRow>(OPEN_OPERATIONS, [
                scope.workspaceId,
                params.channel_id,
                blocking,
              ]);
              const shown = impactOf([], named.rows).blocking;
              throw new Refusal("conflict", "the channel has work in flight", {
                details: {
                  reason: "channel_busy",
                  blocking: shown.map((row) => ({
                    kind: "operation" as const,
                    id: row.id,
                    post_id: row.postId,
                    channel_name: row.channelName,
                    state: row.state,
                  })),
                  ...(blocking.length > LIST_BOUND ? { truncated: true } : {}),
                },
              });
            }
            const channel = await tx.query(
              "SELECT provider_id FROM app.channels WHERE workspace_id = $1 AND id = $2",
              [scope.workspaceId, params.channel_id],
            );
            return { workspaceId: scope.workspaceId, ...channelOf.parse(channel.rows[0]) };
          },
          params.channel_id,
        ),
      );
      const provider = providerOf(deps, first.provider_id);
      const revoke = provider
        ? await deps.credentials.revoke(first.workspaceId, params.channel_id, provider)
        : "unsupported";
      await scoped(true, (tx, scope) =>
        tx.query("SELECT app.credential_destroy($1, $2)", [scope.workspaceId, params.channel_id]),
      );
      return scoped(false, async (tx, scope) => {
        const row = await tx.query(
          "SELECT id, connection_state, disconnected_at, reconnect_deadline FROM app.channels WHERE workspace_id = $1 AND id = $2",
          [scope.workspaceId, params.channel_id],
        );
        return { ...row.rows[0], revoke };
      });
    },
  });
}

export function registerDisconnectRoutes(app: App, ipHmac: IpHmac, deps: DisconnectDeps | undefined): void {
  registerImpact(app, deps);
  if (deps) registerDisconnect(app, ipHmac, deps);
}
