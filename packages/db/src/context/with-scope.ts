import type { Permission } from "@shoutory/core/authz";
import { type AuthorizedScope, mintScope, type ResolvedAccess } from "@shoutory/core/authz/scope";
import type { Pool } from "pg";
import { type TenantTx, withTenant } from "./with-tenant.js";

// One transaction on one connection: the user-only context, the caller's reachable workspaces, the scope minted from
// them, the context narrowed to the target, and only then the handler. A denial rolls the transaction back, so the
// handler never holds a connection that is wider than its scope.

export interface ScopeRequest {
  readonly target: string;
  /** Absent: membership alone grants. */
  readonly permission?: Permission;
  /** Set only for a method that changes data: the one workspace the transaction may write. */
  readonly write: boolean;
}

export type ScopeDenial = "not_found" | "forbidden" | "invalid" | "limit_reached";
export type ScopeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly denial: ScopeDenial };

class Denied extends Error {
  constructor(readonly denial: ScopeDenial) {
    super(`scope denied: ${denial}`);
  }
}

// The definer's own refusals are answers to the caller, not defects; any other state stays an error.
const DEFINER_DENIALS: Readonly<Record<string, ScopeDenial>> = {
  "42501": "not_found",
  "22023": "invalid",
  "54000": "limit_reached",
};

async function resolveAccess(tx: TenantTx): Promise<ResolvedAccess[]> {
  try {
    const found = await tx.query<ResolvedAccess>(
      "SELECT workspace_id, organization_id, role_key FROM app.resolve_workspace_access()",
    );
    return found.rows;
  } catch (error) {
    const state = (error as { code?: unknown }).code;
    const denial = typeof state === "string" ? DEFINER_DENIALS[state] : undefined;
    if (denial) throw new Denied(denial);
    throw error;
  }
}

async function narrow(tx: TenantTx, scope: AuthorizedScope, write: boolean): Promise<void> {
  await tx.query(
    `SELECT set_config('app.organization_id', $1, true), set_config('app.workspace_ids', $2, true),
            set_config('app.write_workspace_id', $3, true)`,
    [scope.organizationId, `{${scope.workspaceId}}`, write ? scope.workspaceId : ""],
  );
}

/**
 * Runs `run` in a transaction whose only context is the signed-in user: for the user-level definers (lists, creates)
 * that need no workspace. The context ends with the transaction.
 */
export function withUser<T>(pool: Pool, principalId: string, run: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(pool, { principalKind: "user", principalId }, run);
}

/**
 * Runs `run` for `principalId` inside the scope minted from the caller's resolved rows for the request's workspace;
 * a denial returns without running.
 */
export async function withScope<T>(
  pool: Pool,
  principalId: string,
  request: ScopeRequest,
  run: (tx: TenantTx, scope: AuthorizedScope) => Promise<T>,
): Promise<ScopeResult<T>> {
  try {
    const value = await withTenant(pool, { principalKind: "user", principalId }, async (tx) => {
      const minted = mintScope(await resolveAccess(tx), principalId, request.target, request.permission);
      if (minted.kind !== "granted") throw new Denied(minted.kind);
      await narrow(tx, minted.scope, request.write);
      return run(tx, minted.scope);
    });
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Denied) return { ok: false, denial: error.denial };
    throw error;
  }
}
