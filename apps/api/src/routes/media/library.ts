import { isImageType, isVideoType } from "@shoutory/core/media";
import type { StorageDriver } from "@shoutory/core/storage";
import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";
import { pageAnswer, pageQuery } from "../input.js";
import { BASE, callDefiner, EDIT_SPLIT, mediaParams, VIEW_SPLIT, workspaceParams } from "./shared.js";

// An allowlist of columns: the storage key, the uploader, the codec facts and the deletion stamp are never answered.
const ANSWER = `a.id, a.file_name, a.mime, a.byte_size::float8 AS byte_size, a.width, a.height, a.duration_ms,
  encode(a.sha256, 'hex') AS sha256, a.state, a.reject_reason, a.in_library, a.tags, a.source, a.created_at,
  (SELECT coalesce(jsonb_object_agg(d.profile, d.state), '{}') FROM app.media_derivatives AS d
    WHERE d.workspace_id = a.workspace_id AND d.media_id = a.id) AS derivatives`;

const printable = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);

const listQuery = z.strictObject({
  ...pageQuery.shape,
  q: printable(255).optional(),
  type: z.enum(["image", "video"]).optional(),
  state: z.enum(["pending_upload", "uploaded", "scanning", "processing", "ready", "rejected"]).optional(),
  tag: printable(64).optional(),
  in_library: z.enum(["true", "false"]).optional(),
});

// The bounds of the tags column, checked here so a long tag is a refusal of the input, never a failed statement.
const metadataBody = z
  .strictObject({
    file_name: printable(255).optional(),
    tags: z.array(printable(64)).max(32).optional(),
    in_library: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });

const derivativeParams = z.strictObject({ ...mediaParams.shape, profile: z.enum(["thumb", "stripped"]) });

// LIKE characters in the search are matched as themselves.
const literal = (text: string) => text.replace(/[\\%_]/g, (found) => `\\${found}`);

async function list(tx: TenantTx, workspaceId: string, query: z.infer<typeof listQuery>) {
  const found = await tx.query(
    `SELECT ${ANSWER} FROM app.media_assets AS a
     WHERE a.workspace_id = $1 AND a.state <> 'deleted' AND ($2::uuid IS NULL OR a.id < $2::uuid)
       AND ($3::text IS NULL OR a.file_name ILIKE '%' || $3 || '%')
       AND ($4::text IS NULL OR a.mime LIKE $4 || '/%')
       AND ($5::text IS NULL OR a.state = $5)
       AND ($6::text IS NULL OR $6 = ANY (a.tags))
       AND ($7::boolean IS NULL OR a.in_library = $7)
     ORDER BY a.id DESC LIMIT $8`,
    [
      workspaceId,
      query.cursor ?? null,
      query.q === undefined ? null : literal(query.q),
      query.type ?? null,
      query.state ?? null,
      query.tag ?? null,
      query.in_library === undefined ? null : query.in_library === "true",
      query.limit,
    ],
  );
  return found.rows;
}

async function one(tx: TenantTx, workspaceId: string, id: string) {
  const found = await tx.query(
    `SELECT ${ANSWER}, (SELECT count(DISTINCT v.post_id)::int FROM app.post_media AS m
       JOIN app.post_variants AS v ON v.workspace_id = m.workspace_id AND v.id = m.variant_id
       WHERE m.workspace_id = a.workspace_id AND m.media_id = a.id) AS post_count
     FROM app.media_assets AS a WHERE a.workspace_id = $1 AND a.id = $2 AND a.state <> 'deleted'`,
    [workspaceId, id],
  );
  const row = found.rows[0];
  if (!row) throw new Refusal("not_found", "media row not visible");
  return row;
}

function registerList(app: App): void {
  defineRoute(app, {
    method: "get",
    path: BASE,
    policy: "session",
    access: VIEW_SPLIT,
    params: workspaceParams,
    query: listQuery,
    handler: async ({ c, scoped, query }) => {
      const rows = await scoped(false, (tx, scope) => list(tx, scope.workspaceId, query));
      return pageAnswer(c, rows, query.limit);
    },
  });
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{media_id}`,
    policy: "session",
    access: VIEW_SPLIT,
    params: mediaParams,
    handler: ({ scoped, params }) =>
      scoped(false, (tx, scope) => one(tx, scope.workspaceId, params.media_id)),
  });
}

// A stripped copy keeps the type of its original only when that is a media type; a thumbnail is always WebP.
const typeOf = (profile: "thumb" | "stripped", mime: string | null) => {
  if (profile === "thumb") return "image/webp";
  return mime !== null && (isImageType(mime) || isVideoType(mime)) ? mime : "application/octet-stream";
};

interface Derivative {
  object_key: string;
  sha256: string;
  byte_size: number;
  mime: string | null;
}

function registerDerivative(app: App, storage: StorageDriver): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{media_id}/derivatives/{profile}`,
    policy: "session",
    access: VIEW_SPLIT,
    params: derivativeParams,
    handler: async ({ scoped, params }) => {
      const found = await scoped(false, (tx, scope) =>
        tx.query<Derivative>(
          `SELECT d.object_key, encode(d.sha256, 'hex') AS sha256, d.byte_size::float8 AS byte_size, a.mime
           FROM app.media_derivatives AS d JOIN app.media_assets AS a
             ON a.workspace_id = d.workspace_id AND a.id = d.media_id
           WHERE d.workspace_id = $1 AND d.media_id = $2 AND d.profile = $3 AND d.state = 'ready'
             AND a.state = 'ready'`,
          [scope.workspaceId, params.media_id, params.profile],
        ),
      );
      const derivative = found.rows[0];
      if (!derivative) throw new Refusal("not_found", "derivative not ready");
      const body = await storage.get(derivative.object_key);
      if (body === null) throw new Refusal("not_found", "derivative object is missing");
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": typeOf(params.profile, derivative.mime),
          "x-content-type-options": "nosniff",
          etag: `"${derivative.sha256}"`,
          "cache-control": "private, no-cache",
        },
      });
    },
  });
}

function registerChanges(app: App): void {
  defineRoute(app, {
    method: "patch",
    path: `${BASE}/{media_id}`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    body: metadataBody,
    handler: ({ scoped, params, body }) =>
      scoped(true, async (tx, scope) => {
        await callDefiner(tx, "SELECT app.media_set_metadata($1, $2, $3, $4, $5)", [
          scope.workspaceId,
          params.media_id,
          body.file_name ?? null,
          body.tags ?? null,
          body.in_library ?? null,
        ]);
        return one(tx, scope.workspaceId, params.media_id);
      }),
  });
  // The medium leaves the library and is deleted unless a post, a pending publish or the avatar still holds it; its
  // files are removed later by the media cleanup.
  defineRoute(app, {
    method: "delete",
    path: `${BASE}/{media_id}`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    handler: async ({ scoped, params }) => {
      await scoped(true, (tx, scope) =>
        callDefiner(tx, "SELECT app.media_delete($1, $2)", [scope.workspaceId, params.media_id]),
      );
      return new Response(null, { status: 204 });
    },
  });
}

export function registerLibrary(app: App, storage: StorageDriver): void {
  registerList(app);
  registerDerivative(app, storage);
  registerChanges(app);
}
