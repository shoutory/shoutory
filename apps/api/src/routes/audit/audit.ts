import { z } from "zod";
import { type App, defineRoute } from "../define-route.js";
import { pageAnswer, pageQuery } from "../input.js";

// The keyed address digest and the chain hashes of a row stay in the database.

const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

// The cursor is a row id, resolved to its position inside this workspace: a foreign or unknown id resolves to nothing
// and the page is empty, never a seek from another workspace's row. The seek is `at <= c.at` plus the tie-break, so
// the (workspace_id, at DESC) index bounds the scan; a row-value comparison would not use it.
const PAGE = `
  SELECT l.id, l.at, l.actor_kind, l.actor_ref, l.action, l.resource_kind, l.resource_id, l.request_id, l.metadata
  FROM app.audit_logs l
  LEFT JOIN app.audit_logs c ON c.workspace_id = $1 AND c.id = $3
  WHERE l.workspace_id = $1
    AND ($3::uuid IS NULL OR (l.at <= c.at AND (l.at < c.at OR l.id < c.id)))
  ORDER BY l.at DESC, l.id DESC
  LIMIT $2`;

export function registerAudit(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/audit-logs",
    policy: "session",
    access: { workspace: "workspace_id", permission: "workspace.danger" },
    params,
    query: pageQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query(PAGE, [scope.workspaceId, query.limit, query.cursor ?? null]);
      return pageAnswer(c, found.rows, query.limit, "id");
    },
  });
}
