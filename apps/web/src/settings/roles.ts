import { msg } from "@lingui/core/macro";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@shoutory/core/authz";

export const ROLES = {
  owner: msg({ id: "role.owner", message: "Owner" }),
  admin: msg({ id: "role.admin", message: "Admin" }),
  editor: msg({ id: "role.editor", message: "Editor" }),
  approver: msg({ id: "role.approver", message: "Approver" }),
  viewer: msg({ id: "role.viewer", message: "Viewer" }),
  member: msg({ id: "role.member", message: "Member" }),
} as const;

// The server decides every change; ranks only limit what the pages offer.
export const rankOf = (role: string) => {
  const at = WORKSPACE_ROLES.indexOf(role as WorkspaceRole);
  return at < 0 ? 0 : WORKSPACE_ROLES.length - at;
};

export const ADMIN_RANK = rankOf("admin");

// Never the Owner, which moves only by transfer.
export const assignableFor = (rank: number) =>
  WORKSPACE_ROLES.filter((role) => role !== "owner" && rankOf(role) <= rank);
