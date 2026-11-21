import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { nameOf } from "../../names.js";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { pageAnswer, pageQuery } from "../input.js";

// The connected accounts of one workspace: list, detail, rename (the nickname only), disable and enable. A member with
// channels.view reads; channels.manage changes. The state moves are the definers of migration 0013, which check the
// caller again and write the audit row. The answer is an allowlist of columns: no credential or provider secret is
// ever a field of it.

const uuid = z.uuid().transform((id) => id.toLowerCase());
const workspaceParams = z.strictObject({ workspace_id: uuid });
const channelParams = z.strictObject({ workspace_id: uuid, channel_id: uuid });
// The nickname is the user's label (null clears it); the provider's display name is never written here.
const rename = z.strictObject({ nickname: nameOf(200).nullable() });

const ANSWER = `id, provider_id, account_kind, display_name, handle, nickname, avatar, connection_state, state_reason,
  health, health_checked_at, token_expires_at, reconnect_deadline, capability_epoch`;

async function read(tx: TenantTx, workspaceId: string, channelId: string) {
  const found = await tx.query(`SELECT ${ANSWER} FROM app.channels WHERE workspace_id = $1 AND id = $2`, [
    workspaceId,
    channelId,
  ]);
  if (!found.rows[0]) throw new Refusal("not_found", "channel row not visible");
  return found.rows[0];
}

type IpHmac = (address: string) => Buffer;

function registerReads(app: App): void {
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
      return pageAnswer(c, found.rows, query.limit);
    },
  });
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/channels/{channel_id}",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.view" },
    params: channelParams,
    handler: ({ tx, scope, params }) => read(tx, scope.workspaceId, params.channel_id),
  });
}

function registerRename(app: App): void {
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
      return read(tx, scope.workspaceId, params.channel_id);
    },
  });
}

// The two definers, by fixed text: the path decides which one runs, never a value the client sent.
const MOVES = {
  disable: "SELECT app.channel_disable($1, $2, $3, $4)",
  enable: "SELECT app.channel_enable($1, $2, $3, $4)",
} as const;

function registerMoves(app: App, ipHmac: IpHmac): void {
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
        return read(tx, scope.workspaceId, params.channel_id);
      },
    });
  }
}

export function registerChannels(app: App, ipHmac: IpHmac): void {
  registerReads(app);
  registerRename(app);
  registerMoves(app, ipHmac);
}
