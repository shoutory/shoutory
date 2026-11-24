// Rules that depend on a policy or on who wrote a post are checked where the action happens and are not keys.
export const PERMISSIONS = [
  "posts.view",
  "posts.edit",
  "approval.decide",
  "publish.override",
  "publish.resolve",
  "channels.view",
  "channels.manage",
  "library.view",
  "library.edit",
  "inbox.view",
  "inbox.act",
  "analytics.view",
  "developers.manage",
  "keys.auto_approve",
  "settings.manage",
  "workspace.danger",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "editor", "approver", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const ADMIN_LACKS: readonly Permission[] = ["publish.override", "keys.auto_approve", "workspace.danger"];

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((permission) => !ADMIN_LACKS.includes(permission)),
  editor: [
    "posts.view",
    "posts.edit",
    "channels.view",
    "library.view",
    "library.edit",
    "inbox.view",
    "inbox.act",
    "analytics.view",
  ],
  approver: ["posts.view", "approval.decide", "library.view", "analytics.view"],
  viewer: ["posts.view", "library.view", "inbox.view", "analytics.view"],
};
