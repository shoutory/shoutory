import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";
import { pageAnswer, pageQuery } from "../input.js";

// The members of one workspace: the list, a role change (ownership transfer included), removing another member and
// leaving. Each change is a definer of migration 0010 that authorizes the caller; the route adds the step-up where
// R247 asks for it and the one refusal of R257 (the remove route is not the leave route).

const uuid = z.uuid().transform((id) => id.toLowerCase());
const workspaceParams = z.strictObject({ workspace_id: uuid });
const memberParams = z.strictObject({ workspace_id: uuid, user_id: uuid });
const roleBody = z.strictObject({ role_key: z.string().min(1).max(32) });

type IpHmac = (address: string) => Buffer;

// The names come from the directory definer (the app role reads no user row); the role joins by user id inside the
// same scope transaction. Implicit organization admins hold no row and are not listed (R260, R262).
const LIST = `
  SELECT d.user_id, d.name, d.image, r.key AS role, m.status
  FROM app.member_directory($1, $2, $3) AS d
  JOIN app.workspace_members AS m ON m.workspace_id = $1 AND m.user_id = d.user_id
  JOIN app.roles AS r ON r.id = m.role_id
  ORDER BY d.user_id`;

function registerList(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/members",
    policy: "session",
    access: { workspace: "workspace_id", permission: "settings.manage" },
    params: workspaceParams,
    query: pageQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query(LIST, [scope.workspaceId, query.limit, query.cursor ?? null]);
      return pageAnswer(c, found.rows, query.limit, "user_id");
    },
  });
}

function registerChanges(app: App, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "patch",
    path: "/api/v1/workspaces/{workspace_id}/members/{user_id}",
    policy: "step_up",
    access: "user",
    params: memberParams,
    body: roleBody,
    handler: ({ c, params, body, clientAddress, inUserTx }) =>
      inUserTx(async (tx) => {
        await tx.query("SELECT app.member_role_set($1, $2, $3, $4, $5)", [
          params.workspace_id,
          params.user_id,
          body.role_key,
          c.get("requestId"),
          ipHmac(clientAddress),
        ]);
        return { user_id: params.user_id, role: body.role_key };
      }),
  });
  defineRoute(app, {
    method: "delete",
    path: "/api/v1/workspaces/{workspace_id}/members/{user_id}",
    policy: "step_up",
    access: "user",
    params: memberParams,
    handler: ({ c, params, clientAddress, inUserTx }) => {
      if (params.user_id === c.get("session").userId) {
        throw new Refusal("conflict", "removing yourself is leaving", { details: { reason: "use_leave" } });
      }
      return inUserTx(async (tx) => {
        await tx.query("SELECT app.member_remove($1, $2, $3, $4)", [
          params.workspace_id,
          params.user_id,
          c.get("requestId"),
          ipHmac(clientAddress),
        ]);
      });
    },
  });
}

// The caller's own id goes to the same definer, which lets anyone but the Owner leave at any rank.
function registerLeave(app: App, ipHmac: IpHmac): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces/{workspace_id}/members/me/leave",
    policy: "session",
    access: "user",
    params: workspaceParams,
    handler: ({ c, params, clientAddress, inUserTx }) =>
      inUserTx(async (tx) => {
        await tx.query("SELECT app.member_remove($1, $2, $3, $4)", [
          params.workspace_id,
          c.get("session").userId,
          c.get("requestId"),
          ipHmac(clientAddress),
        ]);
      }),
  });
}

export function registerMembers(app: App, ipHmac: IpHmac): void {
  registerList(app);
  registerChanges(app, ipHmac);
  registerLeave(app, ipHmac);
}
