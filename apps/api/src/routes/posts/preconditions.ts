import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import type { TenantTx } from "@shoutory/db/context";
import type { Context } from "hono";
import { Refusal } from "../../errors/refusal.js";
import type { AppEnv } from "../define-route.js";

const POST = `SELECT id, status, current_version_id, author_kind, author_id, created_at, updated_at
  FROM app.posts WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`;

// Row security does not hide a deleted post, so every read and write path says so itself.
export async function livePost(tx: TenantTx, scope: AuthorizedScope, postId: string) {
  const found = await tx.query(POST, [scope.workspaceId, postId]);
  const row = found.rows[0];
  if (!row) throw new Refusal("not_found", "post row not visible");
  return row as Record<string, unknown> & { current_version_id: string };
}

const QUOTED_VERSION = /^"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"$/i;

export function expectedVersion(c: Context<AppEnv>): string {
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

// A write whose version no longer is the post's current one changes nothing and says which version is.
export function staleRefusal(version: string): Refusal {
  return new Refusal("precondition_failed", "the post has moved on", {
    details: { current_version_id: version },
    etag: `"${version}"`,
  });
}
