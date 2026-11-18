import { type Permission, ROLE_PERMISSIONS, type WorkspaceRole } from "./matrix.js";

// An AuthorizedScope is proof that a caller reached one workspace with one permission. The brand is a symbol that is
// declared here and never exported, so the only way to hold a scope is to get it from `mintScope`.

declare const scopeBrand: unique symbol;

export interface AuthorizedScope {
  readonly [scopeBrand]: true;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
}

/** One row of `resolve_workspace_access()`: a workspace the caller reaches and the role it holds there. */
export interface ResolvedAccess {
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly role_key: string;
}

export type MintResult =
  | { readonly kind: "granted"; readonly scope: AuthorizedScope }
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden" };

function holds(roleKey: string, permission: Permission): boolean {
  if (!Object.hasOwn(ROLE_PERMISSIONS, roleKey)) return false;
  return ROLE_PERMISSIONS[roleKey as WorkspaceRole].includes(permission);
}

/**
 * The only constructor of a scope. A workspace outside the resolved rows is `not_found` (the caller may not learn it
 * exists); a reached workspace whose role lacks `permission` is `forbidden`. Without a permission any resolved row
 * grants (membership only). A role key the matrix does not know holds no permission.
 */
export function mintScope(
  rows: readonly ResolvedAccess[],
  principalId: string,
  target: string,
  permission?: Permission,
): MintResult {
  const row = rows.find((candidate) => candidate.workspace_id === target);
  if (!row) return { kind: "not_found" };
  if (permission !== undefined && !holds(row.role_key, permission)) return { kind: "forbidden" };
  const scope = {
    principalId,
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
  } as AuthorizedScope;
  return { kind: "granted", scope };
}
