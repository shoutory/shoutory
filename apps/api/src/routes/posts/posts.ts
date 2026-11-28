import type { Permission } from "@shoutory/core/authz";
import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import { draftSchema } from "@shoutory/core/content";
import type { TenantTx } from "@shoutory/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { Throttle } from "../../auth/throttle.js";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { pageAnswer, pageQuery } from "../input.js";
import { HOLD_REASON, TARGETS_COLUMN, targetsWithActions } from "./post-detail.js";
import { expectedVersion, livePost, staleRefusal } from "./preconditions.js";
import { registerPublish } from "./publish.js";
import { resolveDraft } from "./resolve.js";

const uuid = z.uuid().transform((id) => id.toLowerCase());
const workspaceParams = z.strictObject({ workspace_id: uuid });
const postParams = z.strictObject({ workspace_id: uuid, post_id: uuid });
const versionParams = z.strictObject({ workspace_id: uuid, post_id: uuid, version_id: uuid });
const draftBody = z.strictObject({ draft: draftSchema });

type Providers = Readonly<Record<string, HealthProvider>>;
const BASE = "/api/v1/workspaces/{workspace_id}/posts";
const VIEW = { workspace: "workspace_id", permission: "posts.view" } as const;
const EDIT = { workspace: "workspace_id", permission: "posts.edit" } as const;

const answer = (c: Context<AppEnv>, status: 200 | 201, data: unknown, version: string): Response =>
  c.json({ data }, status, { ETag: `"${version}"` });

// A write's own database refusals, answered after the transaction has rolled back: a check the document check missed
// (it carries the failing row, which a 500 would log), a duplicate and a channel or medium removed meanwhile.
function databaseRefusal(error: unknown): Refusal | undefined {
  const { code, table, message } = error as { code?: unknown; table?: unknown; message?: unknown };
  const ours =
    (typeof table === "string" && table.startsWith("post_")) ||
    (typeof message === "string" && message.startsWith("post:"));
  if (!ours) return undefined;
  const refuse = (kind: "unprocessable_content" | "conflict", reason: string) =>
    new Refusal(kind, `post write refused: ${reason}`, { cause: error, details: { reason } });
  if (code === "23514") return refuse("unprocessable_content", "content_bound");
  if (code === "23505") return refuse("conflict", "duplicate_variant");
  return code === "23503" ? refuse("conflict", "reference_removed") : undefined;
}

async function callDefiner(tx: TenantTx, sql: string, params: unknown[]): Promise<Record<string, string>> {
  try {
    return ((await tx.query(sql, params)).rows[0] ?? {}) as Record<string, string>;
  } catch (error) {
    throw definerRefusal(error) ?? databaseRefusal(error) ?? error;
  }
}

function registerCreate(app: App, providers: Providers, now: () => Date): void {
  defineRoute(app, {
    method: "post",
    path: BASE,
    policy: "session",
    access: EDIT,
    params: workspaceParams,
    body: draftBody,
    status: 201,
    handler: async ({ c, tx, scope, body }) => {
      const { snapshot, hash } = await resolveDraft(tx, scope.workspaceId, body.draft, providers, now());
      const made = await callDefiner(tx, "SELECT * FROM app.post_create($1, $2::jsonb, $3)", [
        scope.workspaceId,
        JSON.stringify(snapshot),
        hash,
      ]);
      return answer(c, 201, { id: made.post_id, version_id: made.version_id }, made.version_id as string);
    },
  });
}

// The post, its variants and their media in one statement: one snapshot, so the ETag (the current version) always names
// the content shown, whatever a concurrent autosave does between two reads.
const READ_POST = `
  SELECT p.id, p.status, p.current_version_id, p.author_kind, p.author_id, p.created_at, p.updated_at,
    coalesce((SELECT json_agg(v ORDER BY v.id) FROM (
      SELECT s.id, s.channel_id, s.locale, s.post_type, s.text, s.parts, s.settings,
        coalesce((SELECT json_agg(json_build_object('position', m.position, 'media_id', m.media_id,
            'alt_text', m.alt_text, 'crop', m.crop) ORDER BY m.position)
          FROM app.post_media AS m WHERE m.workspace_id = p.workspace_id AND m.variant_id = s.id), '[]'::json) AS media
      FROM app.post_variants AS s WHERE s.workspace_id = p.workspace_id AND s.post_id = p.id) AS v), '[]'::json) AS variants,
    ${TARGETS_COLUMN}
  FROM app.posts AS p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`;

const POST_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "partially_published",
  "needs_attention",
  "failed",
  "missed",
  "archived",
] as const;
const listQuery = pageQuery.extend({ status: z.enum(POST_STATUSES).optional() });

// One row per post: the excerpt comes from the current version's draft, and a target carries only its schedule facts,
// the held reason and the state of its latest operation, never an operation's code or a provider's words. The cursor is a
// post id resolved to its position, so a foreign or unknown id resolves to nothing and the page is empty.
const LIST_POSTS = `
  SELECT p.id, p.status, p.author_kind, p.author_id, p.updated_at, p.current_version_id,
    (SELECT left(v.snapshot -> 'draft' -> 'variants' -> 0 ->> 'text', 140) FROM app.post_versions AS v
      WHERE v.workspace_id = p.workspace_id AND v.id = p.current_version_id) AS excerpt,
    t.targets, t.published_count, t.target_count
  FROM app.posts AS p
  LEFT JOIN app.posts AS c ON c.workspace_id = $1 AND c.id = $3
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'variant_id', s.id, 'channel_id', s.channel_id, 'schedule_state', s.schedule_state, 'due_at', s.due_at,
        'due_tz', s.due_tz, 'published_at', s.published_at, 'presence', s.presence, 'hold_reason', ${HOLD_REASON},
        'operation_state', (SELECT o.state FROM app.operations AS o
          WHERE o.workspace_id = s.workspace_id AND o.variant_id = s.id ORDER BY o.created_at DESC, o.id DESC LIMIT 1))
      ORDER BY s.id), '[]'::jsonb) AS targets,
      count(*)::int AS target_count, count(s.published_at)::int AS published_count
    FROM app.post_variants AS s WHERE s.workspace_id = p.workspace_id AND s.post_id = p.id) AS t
  WHERE p.workspace_id = $1 AND p.deleted_at IS NULL AND ($4::text IS NULL OR p.status = $4)
    AND ($3::uuid IS NULL OR (p.updated_at <= c.updated_at AND (p.updated_at < c.updated_at OR p.id < c.id)))
  ORDER BY p.updated_at DESC, p.id DESC
  LIMIT $2`;

function registerList(app: App): void {
  defineRoute(app, {
    method: "get",
    path: BASE,
    policy: "session",
    access: VIEW,
    params: workspaceParams,
    query: listQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query(LIST_POSTS, [
        scope.workspaceId,
        query.limit,
        query.cursor ?? null,
        query.status ?? null,
      ]);
      return pageAnswer(c, found.rows, query.limit);
    },
  });
}

function registerVersion(app: App): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{post_id}/versions/{version_id}`,
    policy: "session",
    access: VIEW,
    params: versionParams,
    handler: async ({ tx, scope, params }) => {
      const found = await tx.query(
        `SELECT v.id, v.version_no, v.kind, v.created_by, v.created_at, v.snapshot -> 'draft' AS draft
         FROM app.post_versions AS v JOIN app.posts AS p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
         WHERE v.workspace_id = $1 AND v.post_id = $2 AND v.id = $3 AND p.deleted_at IS NULL`,
        [scope.workspaceId, params.post_id, params.version_id],
      );
      if (!found.rows[0]) throw new Refusal("not_found", "version row not visible");
      return found.rows[0];
    },
  });
}

function registerGet(app: App, providers: Providers, now: () => Date): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{post_id}`,
    policy: "session",
    access: VIEW,
    params: postParams,
    handler: async ({ c, tx, scope, params }) => {
      const sees = (permission: Permission) => scope.permissions.has(permission);
      const read = await tx.query(READ_POST, [
        scope.workspaceId,
        params.post_id,
        sees("posts.edit"),
        sees("publish.resolve"),
      ]);
      const post = read.rows[0];
      if (!post) throw new Refusal("not_found", "post row not visible");
      const targets = targetsWithActions(post.targets, {
        scope,
        providers,
        authorId: post.author_id,
        now: now(),
      });
      return answer(c, 200, { ...post, targets }, post.current_version_id);
    },
  });
}

function registerVersions(app: App): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{post_id}/versions`,
    policy: "session",
    access: VIEW,
    params: postParams,
    query: pageQuery,
    handler: async ({ c, tx, scope, params, query }) => {
      const post = await livePost(tx, scope, params.post_id);
      // The cursor is a version id, read here as its number.
      const found = await tx.query(
        `SELECT v.id, v.version_no, v.kind, v.created_by, v.created_at FROM app.post_versions AS v
         WHERE v.workspace_id = $1 AND v.post_id = $2 AND ($3::uuid IS NULL OR v.version_no < (
           SELECT c.version_no FROM app.post_versions AS c WHERE c.workspace_id = $1 AND c.post_id = $2 AND c.id = $3))
         ORDER BY v.version_no DESC LIMIT $4`,
        [scope.workspaceId, params.post_id, query.cursor ?? null, query.limit],
      );
      const page = pageAnswer(c, found.rows, query.limit);
      page.headers.set("etag", `"${post.current_version_id}"`);
      return page;
    },
  });
}

// The pending variants are scheduled or approved ones whose change publishes only once they are scheduled again.
function settled(outcome: Record<string, unknown>, c: Context<AppEnv>, status: 200 | 201, postId: string) {
  const version = outcome.version_id as string;
  if (outcome.outcome === "stale") throw staleRefusal(version);
  const data = { id: postId, version_id: version, pending_changes: outcome.pending_changes };
  return answer(c, status, data, version);
}

// The two definers, by fixed text: the path decides which one runs, never a value the client sent.
const CHANGES = {
  autosave: "SELECT * FROM app.post_autosave($1, $2, $3, $4::jsonb, $5)",
  save: "SELECT * FROM app.post_save($1, $2, $3, $4::jsonb, $5)",
} as const;

function registerChange(
  app: App,
  providers: Providers,
  now: () => Date,
  kind: keyof typeof CHANGES,
  throttle: Throttle,
): void {
  defineRoute(app, {
    method: kind === "autosave" ? "patch" : "post",
    path: kind === "autosave" ? `${BASE}/{post_id}` : `${BASE}/{post_id}/save`,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: draftBody,
    handler: async ({ c, tx, scope, params, body }) => {
      const expected = expectedVersion(c);
      if (kind === "autosave") await throttle.spend("post_autosave", c.get("session").userId);
      const { snapshot, hash } = await resolveDraft(tx, scope.workspaceId, body.draft, providers, now());
      const outcome = await callDefiner(tx, CHANGES[kind], [
        scope.workspaceId,
        params.post_id,
        expected,
        JSON.stringify(snapshot),
        hash,
      ]);
      return settled(outcome, c, 200, params.post_id);
    },
  });
}

// A draft that the document check no longer takes (a bound tightened since) is refused like one that no longer resolves.
async function recordedDraft(tx: TenantTx, scope: AuthorizedScope, postId: string, versionId: string) {
  const found = await tx.query(
    "SELECT snapshot -> 'draft' AS draft FROM app.post_versions WHERE workspace_id = $1 AND post_id = $2 AND id = $3",
    [scope.workspaceId, postId, versionId],
  );
  if (!found.rows[0]) throw new Refusal("not_found", "version row not visible");
  const draft = draftSchema.safeParse(found.rows[0].draft);
  if (!draft.success) {
    throw new Refusal("unprocessable_content", "recorded draft no longer valid", {
      details: { reason: "draft_invalid" },
    });
  }
  return draft.data;
}

// The definer copies the recorded snapshot, which stays the historical record; the route first checks that the draft in
// it still resolves (medium, channel, settings), so a restore is refused for the same reasons an autosave would be.
function registerRestore(app: App, providers: Providers, now: () => Date): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/{post_id}/versions/{version_id}/restore`,
    policy: "session",
    access: EDIT,
    params: versionParams,
    status: 201,
    handler: async ({ c, tx, scope, params }) => {
      const expected = expectedVersion(c);
      const draft = await recordedDraft(tx, scope, params.post_id, params.version_id);
      await resolveDraft(tx, scope.workspaceId, draft, providers, now());
      const outcome = await callDefiner(tx, "SELECT * FROM app.post_restore($1, $2, $3, $4)", [
        scope.workspaceId,
        params.post_id,
        expected,
        params.version_id,
      ]);
      return settled(outcome, c, 201, params.post_id);
    },
  });
}

export function registerPosts(
  app: App,
  providers: Providers,
  options: { now?: () => number; auth: { throttle: Throttle; ipHmac: (address: string) => Buffer } },
): void {
  const now = () => new Date(options.now?.() ?? Date.now());
  const { throttle } = options.auth;
  registerCreate(app, providers, now);
  registerList(app);
  registerGet(app, providers, now);
  registerVersions(app);
  registerVersion(app);
  registerChange(app, providers, now, "autosave", throttle);
  registerChange(app, providers, now, "save", throttle);
  registerRestore(app, providers, now);
  registerPublish(app, options.auth.ipHmac, { providers, now });
}
