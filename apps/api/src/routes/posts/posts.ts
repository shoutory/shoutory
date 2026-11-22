import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import { draftSchema } from "@shoutory/core/content";
import type { TenantTx } from "@shoutory/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";
import { type App, type AppEnv, defineRoute } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { pageAnswer, pageQuery } from "../input.js";
import { resolveDraft } from "./resolve.js";

// The posts of one workspace: create, read, the list of versions, autosave, save and restore. A member with posts.view
// reads and posts.edit changes. Every change goes through a post definer, which checks the caller again; the answer to
// a change carries the new version as its ETag, and a change names the version it is based on in If-Match.

const uuid = z.uuid().transform((id) => id.toLowerCase());
const workspaceParams = z.strictObject({ workspace_id: uuid });
const postParams = z.strictObject({ workspace_id: uuid, post_id: uuid });
const versionParams = z.strictObject({ workspace_id: uuid, post_id: uuid, version_id: uuid });
const draftBody = z.strictObject({ draft: draftSchema });

type Providers = Readonly<Record<string, HealthProvider>>;
const BASE = "/api/v1/workspaces/{workspace_id}/posts";
const VIEW = { workspace: "workspace_id", permission: "posts.view" } as const;
const EDIT = { workspace: "workspace_id", permission: "posts.edit" } as const;

/** An answer that carries the version it shows as its strong ETag. */
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

/** Runs one definer call and turns its refusals into answers. */
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

const POST = `SELECT id, status, current_version_id, author_kind, author_id, created_at, updated_at
  FROM app.posts WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`;

// RLS template W does not hide a deleted post, so every read and write path says so itself.
async function livePost(tx: TenantTx, scope: AuthorizedScope, postId: string) {
  const found = await tx.query(POST, [scope.workspaceId, postId]);
  const row = found.rows[0];
  if (!row) throw new Refusal("not_found", "post row not visible");
  return row as Record<string, unknown> & { current_version_id: string };
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
      FROM app.post_variants AS s WHERE s.workspace_id = p.workspace_id AND s.post_id = p.id) AS v), '[]'::json) AS variants
  FROM app.posts AS p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`;

function registerGet(app: App): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{post_id}`,
    policy: "session",
    access: VIEW,
    params: postParams,
    handler: async ({ c, tx, scope, params }) => {
      const post = (await tx.query(READ_POST, [scope.workspaceId, params.post_id])).rows[0];
      if (!post) throw new Refusal("not_found", "post row not visible");
      return answer(c, 200, post, post.current_version_id);
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
      // Newest first: the cursor is a version id, read here as its number.
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

const QUOTED_VERSION = /^"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/i;

/** The version a change is based on: exactly one quoted version id in If-Match (no `*`, weak validator or list). */
function expectedVersion(c: Context<AppEnv>): string {
  const header = c.req.header("if-match");
  if (header === undefined) throw new Refusal("precondition_required", "If-Match is missing");
  const found = QUOTED_VERSION.exec(header);
  if (!found) {
    throw new Refusal("validation_failed", "If-Match is not one quoted version id", {
      details: { target: "if-match" },
    });
  }
  return (found[1] as string).toLowerCase();
}

/** A stale outcome is the 412 that names the version the post is at now; the transaction ends with no change. */
function settled(outcome: Record<string, string>, c: Context<AppEnv>, status: 200 | 201, postId: string) {
  const version = outcome.version_id as string;
  if (outcome.outcome === "stale") {
    throw new Refusal("precondition_failed", "the post has moved on", {
      details: { current_version_id: version },
      etag: `"${version}"`,
    });
  }
  return answer(c, status, { id: postId, version_id: version }, version);
}

// The two definers, by fixed text: the path decides which one runs, never a value the client sent.
const CHANGES = {
  autosave: "SELECT * FROM app.post_autosave($1, $2, $3, $4::jsonb, $5)",
  save: "SELECT * FROM app.post_save($1, $2, $3, $4::jsonb, $5)",
} as const;

function registerChange(app: App, providers: Providers, now: () => Date, kind: keyof typeof CHANGES): void {
  defineRoute(app, {
    method: kind === "autosave" ? "patch" : "post",
    path: kind === "autosave" ? `${BASE}/{post_id}` : `${BASE}/{post_id}/save`,
    policy: "session",
    access: EDIT,
    params: postParams,
    body: draftBody,
    handler: async ({ c, tx, scope, params, body }) => {
      const expected = expectedVersion(c);
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

/**
 * The draft a version recorded, read as the document it was. A version of another post is not found. A draft that the
 * document check no longer takes (a bound tightened since) is refused like one that no longer resolves.
 */
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

export function registerPosts(app: App, providers: Providers, now: () => Date): void {
  registerCreate(app, providers, now);
  registerGet(app);
  registerVersions(app);
  registerChange(app, providers, now, "autosave");
  registerChange(app, providers, now, "save");
  registerRestore(app, providers, now);
}
