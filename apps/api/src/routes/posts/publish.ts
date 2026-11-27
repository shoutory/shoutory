import { z } from "zod";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { requireIdempotencyKey } from "../idempotency-key.js";
import { workspaceDue } from "../operations/operations.js";

// Schedule, Update schedule, publish now and unschedule (the Undo). The permission is posts.edit for all four; the
// definers check the post, its targets and their channels under the post lock.
const uuid = z.uuid().transform((id) => id.toLowerCase());
const postParams = z.strictObject({ workspace_id: uuid, post_id: uuid });
const targets = { variant_ids: z.array(uuid).min(1).max(100).optional() };
const scheduleBody = z.strictObject({
  local_due: z.string().max(32),
  fold: z.enum(["earlier", "later"]).optional(),
  ...targets,
});
const targetsBody = z.strictObject(targets);
const BASE = "/api/v1/workspaces/{workspace_id}/posts/{post_id}";
const EDIT = { workspace: "workspace_id", permission: "posts.edit" } as const;

type IpHmac = (address: string) => Buffer;

function registerSchedule(app: App, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/schedule`,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: scheduleBody,
    handler: async ({ c, tx, scope, params, body, clientAddress }) => {
      requireIdempotencyKey(c);
      const due = await workspaceDue(tx, scope.workspaceId, body.local_due, body.fold);
      const done = await tx
        .query<{ ids: string[] }>("SELECT app.post_schedule($1, $2, $3::uuid[], $4, $5, $6, false) AS ids", [
          scope.workspaceId,
          params.post_id,
          body.variant_ids ?? null,
          due.local_due,
          due.due_tz,
          due.due_at,
        ])
        .catch((error: unknown) => {
          throw definerRefusal(error) ?? error;
        });
      await tx.query("SELECT app.audit_insert('post.scheduled', 'post', $1, $2, $3, $4::jsonb)", [
        params.post_id,
        c.get("requestId"),
        ipHmac(clientAddress),
        JSON.stringify({ variants: done.rows[0]?.ids ?? [] }),
      ]);
      return { post_id: params.post_id, variant_ids: done.rows[0]?.ids ?? [], ...due };
    },
  });
}

function registerMarks(app: App, ipHmac: IpHmac): void {
  for (const [name, sql, action] of [
    ["publish", "SELECT app.post_publish_now($1, $2, $3::uuid[]) AS ids", "post.publish_now"],
    ["unschedule", "SELECT app.post_unschedule($1, $2, $3::uuid[]) AS ids", "post.unscheduled"],
  ] as const) {
    defineRoute(app, {
      method: "post",
      path: `${BASE}/${name}`,
      policy: "session",
      access: EDIT,
      params: postParams,
      body: targetsBody,
      handler: async ({ c, tx, scope, params, body, clientAddress }) => {
        requireIdempotencyKey(c);
        const done = await tx
          .query<{ ids: string[] }>(sql, [scope.workspaceId, params.post_id, body.variant_ids ?? null])
          .catch((error: unknown) => {
            throw definerRefusal(error) ?? error;
          });
        await tx.query("SELECT app.audit_insert($1, 'post', $2, $3, $4, $5::jsonb)", [
          action,
          params.post_id,
          c.get("requestId"),
          ipHmac(clientAddress),
          JSON.stringify({ variants: done.rows[0]?.ids ?? [] }),
        ]);
        return { post_id: params.post_id, variant_ids: done.rows[0]?.ids ?? [] };
      },
    });
  }
}

export function registerPublish(app: App, ipHmac: IpHmac): void {
  registerSchedule(app, ipHmac);
  registerMarks(app, ipHmac);
}
