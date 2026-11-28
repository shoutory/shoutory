import { z } from "zod";
import { type App, defineRoute } from "../define-route.js";
import { pageAnswer, pageQuery } from "../input.js";

const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

// The policy of the table keeps the reader to their own rows. The cursor is a notice id resolved to its position among
// those rows, so another reader's id resolves to nothing and the page is empty.
const PAGE = `
  SELECT n.id, n.kind, n.subject_id, n.level, n.vars, n.created_at, n.read_at
  FROM app.notifications n
  LEFT JOIN app.notifications c ON c.workspace_id = $1 AND c.id = $3
  WHERE n.workspace_id = $1
    AND ($3::uuid IS NULL OR (n.created_at <= c.created_at AND (n.created_at < c.created_at OR n.id < c.id)))
  ORDER BY n.created_at DESC, n.id DESC
  LIMIT $2`;

export function registerNotices(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/notifications",
    policy: "session",
    access: { workspace: "workspace_id" },
    params,
    query: pageQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query(PAGE, [scope.workspaceId, query.limit, query.cursor ?? null]);
      return pageAnswer(c, found.rows, query.limit, "id");
    },
  });
}
