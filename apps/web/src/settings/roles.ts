import { msg } from "@lingui/core/macro";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@shoutory/core/authz";

/** The words of the built-in workspace roles; a role the list does not know shows the generic member word. */
export const ROLES = {
  owner: msg({ id: "role.owner", message: "Owner" }),
  admin: msg({ id: "role.admin", message: "Admin" }),
  editor: msg({ id: "role.editor", message: "Editor" }),
  approver: msg({ id: "role.approver", message: "Approver" }),
  viewer: msg({ id: "role.viewer", message: "Viewer" }),
  member: msg({ id: "role.member", message: "Member" }),
} as const;

/**
 * A rank is the place in the built-in role order, the Owner highest; a role the order does not know has none. The
 * server holds the same weights and decides every change; the pages only offer what the server would allow.
 */
export const rankOf = (role: string) => {
  const at = WORKSPACE_ROLES.indexOf(role as WorkspaceRole);
  return at < 0 ? 0 : WORKSPACE_ROLES.length - at;
};

/** The rank that may manage members and invitations. */
export const ADMIN_RANK = rankOf("admin");

/**
 * The roles a caller of `rank` can give or invite as: no higher than their own, and never the Owner, which moves only
 * by transfer.
 */
export const assignableFor = (rank: number) =>
  WORKSPACE_ROLES.filter((role) => role !== "owner" && rankOf(role) <= rank);
