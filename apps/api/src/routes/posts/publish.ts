import { draftSchema } from "@shoutory/core/content";
import { providersArgument } from "@shoutory/core/ledger/client";
import { z } from "zod";
import type { HealthProvider } from "../../channels/health.js";
import { type App, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { requireIdempotencyKey } from "../idempotency-key.js";
import { workspaceDue } from "../operations/operations.js";
import { expectedVersion, livePost, staleRefusal } from "./preconditions.js";
import { checkForSchedule, checkVariants, resolveDraft } from "./resolve.js";

// Schedule, Update schedule, publish now, unschedule (the Undo), edit and delete. The permission is posts.edit for all
// of them; the definers check the post, its targets and their channels under the post lock.
type Providers = Readonly<Record<string, HealthProvider>>;
const draftBody = z.strictObject({ draft: draftSchema });
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

function registerSchedule(app: App, deps: Deps, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/schedule`,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: scheduleBody,
    handler: async ({ c, tx, scope, params, body, clientAddress }) => {
      requireIdempotencyKey(c);
      await livePost(tx, scope, params.post_id);
      const version = await checkForSchedule(
        tx,
        scope.workspaceId,
        params.post_id,
        body.variant_ids,
        deps.providers,
      );
      const due = await workspaceDue(tx, scope.workspaceId, body.local_due, body.fold);
      const done = await tx
        .query<{ ids: string[] }>(
          "SELECT app.post_schedule($1, $2, $3::uuid[], $4, $5, $6, false, $7) AS ids",
          [
            scope.workspaceId,
            params.post_id,
            body.variant_ids ?? null,
            due.local_due,
            due.due_tz,
            due.due_at,
            version,
          ],
        )
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

function registerMarks(app: App, deps: Deps, ipHmac: IpHmac): void {
  for (const [name, sql, action] of [
    ["publish", "SELECT app.post_publish_now($1, $2, $3::uuid[], $4) AS ids", "post.publish_now"],
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
        const args: unknown[] = [scope.workspaceId, params.post_id, body.variant_ids ?? null];
        if (name === "publish") {
          await livePost(tx, scope, params.post_id);
          args.push(
            await checkForSchedule(tx, scope.workspaceId, params.post_id, body.variant_ids, deps.providers),
          );
        }
        const done = await tx
          .query<{ ids: string[] }>(sql, args)
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

interface Deps {
  readonly providers: Providers;
  readonly now: () => Date;
}

// The provider facts the definers read: the leases, which say what a provider can do, and the edit window.
const factsOf = (providers: Providers): string =>
  JSON.stringify(providersArgument(Object.values(providers).map((provider) => provider.manifest)));

// An edit writes the new version of a published post and admits one edit operation per changed target; the path and
// the definer, never a value the client sent, decide that it is an edit.
function registerEdit(app: App, deps: Deps, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/edit`,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: draftBody,
    handler: async ({ c, tx, scope, params, body, clientAddress }) => {
      requireIdempotencyKey(c);
      const expected = expectedVersion(c);
      await livePost(tx, scope, params.post_id);
      const { snapshot, hash } = await resolveDraft(
        tx,
        scope.workspaceId,
        body.draft,
        deps.providers,
        deps.now(),
      );
      await checkVariants(tx, scope.workspaceId, body.draft, deps.providers);
      const done = await tx
        .query<{ outcome: string; version_id: string; operation_ids: string[] }>(
          "SELECT * FROM app.post_edit($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)",
          [
            scope.workspaceId,
            params.post_id,
            expected,
            JSON.stringify(snapshot),
            hash,
            factsOf(deps.providers),
            c.get("requestId"),
            ipHmac(clientAddress),
          ],
        )
        .catch((error: unknown) => {
          throw definerRefusal(error) ?? error;
        });
      const row = done.rows[0];
      if (!row || row.outcome === "stale") throw staleRefusal(row?.version_id ?? expected);
      c.header("ETag", `"${row.version_id}"`);
      return { id: params.post_id, version_id: row.version_id, operation_ids: row.operation_ids };
    },
  });
}

// A delete asks the provider to remove every published target of the post, or the targets named. It carries the post's
// version in If-Match like a save does.
function registerDelete(app: App, deps: Deps, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "delete",
    path: BASE,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: targetsBody,
    optionalBody: true,
    handler: async ({ c, tx, scope, params, body, clientAddress }) => {
      requireIdempotencyKey(c);
      const expected = expectedVersion(c);
      const done = await tx
        .query<{ outcome: string; version_id: string; operation_ids: string[] }>(
          "SELECT * FROM app.post_delete($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7)",
          [
            scope.workspaceId,
            params.post_id,
            expected,
            body.variant_ids ?? null,
            factsOf(deps.providers),
            c.get("requestId"),
            ipHmac(clientAddress),
          ],
        )
        .catch((error: unknown) => {
          throw definerRefusal(error) ?? error;
        });
      const row = done.rows[0];
      if (!row || row.outcome === "stale") throw staleRefusal(row?.version_id ?? expected);
      return { post_id: params.post_id, operation_ids: row.operation_ids };
    },
  });
}

export function registerPublish(app: App, ipHmac: IpHmac, deps: Deps): void {
  registerSchedule(app, deps, ipHmac);
  registerMarks(app, deps, ipHmac);
  registerEdit(app, deps, ipHmac);
  registerDelete(app, deps, ipHmac);
}
