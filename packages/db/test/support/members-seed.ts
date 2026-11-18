import { createHash, randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import { openTx } from "./race.js";

// One tenancy fixture for the member and invitation definer tests. Workspace WA holds a stored Owner, two stored
// admins, an editor, an approver and two viewers; UVOA is a stored viewer who is also an organization Admin (effective
// rank admin) and UORG is an implicit admin with no stored row. WB is another organization's workspace.
const id = () => randomUUID();
export const U = {
  owner: id(),
  admin: id(),
  admin2: id(),
  editor: id(),
  approver: id(),
  viewer: id(),
  viewerOrgAdmin: id(),
  orgAdmin: id(),
  orgOwner: id(),
  inviter1: id(),
  inviter2: id(),
  inviter3: id(),
  invitee: id(),
  unverified: id(),
  alreadyMember: id(),
  outsider: id(),
  racer: id(),
  bOwner: id(),
};
export const OA = id();
export const OB = id();
export const WA = id();
export const WB = id();
export const EMAIL = { invitee: "invitee-m06a@example.test", other: "other-m06a@example.test" };

const mail = (key: string) => `${key.toLowerCase()}-m06a@example.test`;
const ROLE = (key: string) =>
  `(SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = '${key}')`;

export const asUser = (userId: string): TenantCtx => ({ principalKind: "user", principalId: userId });
export const digestOf = (token: string): Buffer => createHash("sha256").update(token).digest();

export async function seedMembers(admin: Client): Promise<void> {
  const users = Object.entries(U).map(([key, uid]) => {
    const email = key === "invitee" ? EMAIL.invitee : mail(key);
    return `('${uid}', 'm06a-${key}', '${email}', ${key !== "unverified"})`;
  });
  await admin.query(`INSERT INTO auth."user" (id, name, email, email_verified) VALUES ${users.join(",")}`);
  await admin.query(
    `INSERT INTO app.organizations (id, name, slug, type) VALUES
       ('${OA}', 'm06a-a', 'm06a-a', 'team'), ('${OB}', 'm06a-b', 'm06a-b', 'team');
     INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES
       ('${OA}', '${U.orgOwner}', 'owner'), ('${OA}', '${U.orgAdmin}', 'admin'), ('${OA}', '${U.viewerOrgAdmin}', 'admin'),
       ('${OA}', '${U.inviter3}', 'admin'), ('${OB}', '${U.bOwner}', 'owner');
     INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES
       ('${WA}', '${OA}', 'm06a-wa', 'm06a-wa'), ('${WB}', '${OB}', 'm06a-wb', 'm06a-wb');
     INSERT INTO app.workspace_members (workspace_id, user_id, role_id) VALUES
       ('${WA}', '${U.owner}', ${ROLE("owner")}), ('${WA}', '${U.admin}', ${ROLE("admin")}),
       ('${WA}', '${U.admin2}', ${ROLE("admin")}), ('${WA}', '${U.editor}', ${ROLE("editor")}),
       ('${WA}', '${U.approver}', ${ROLE("approver")}), ('${WA}', '${U.viewer}', ${ROLE("viewer")}),
       ('${WA}', '${U.viewerOrgAdmin}', ${ROLE("viewer")}), ('${WA}', '${U.inviter1}', ${ROLE("admin")}),
       ('${WA}', '${U.inviter2}', ${ROLE("admin")}), ('${WA}', '${U.alreadyMember}', ${ROLE("viewer")}),
       ('${WB}', '${U.bOwner}', ${ROLE("owner")})`,
  );
}

export interface Planted {
  token: string;
  /** The workspace of the row; WA when absent. */
  ws?: string;
  email?: string;
  role?: string;
  by?: string;
  expires?: string;
  used?: boolean;
  revoked?: boolean;
}

/**
 * Inserts one invitation row as the superuser, in any state, for the accept tests; the token is hashed here. A pending
 * row ends an earlier pending row of the same address, as the one-pending-row key requires.
 */
export async function plantInvitation(admin: Client, o: Planted): Promise<void> {
  if (!o.used && !o.revoked) {
    await admin.query(
      `UPDATE app.invitations SET revoked_at = now()
       WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [o.ws ?? WA, o.email ?? EMAIL.invitee],
    );
  }
  await admin.query(
    `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, invited_by, expires_at, accepted_at,
       accepted_by, revoked_at)
     VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.key = $3 AND (r.workspace_id IS NULL OR r.workspace_id = $1)),
       $4, $5, now() + $6::interval, CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN $8::uuid END,
       CASE WHEN $9 THEN now() END)`,
    [
      o.ws ?? WA,
      o.email ?? EMAIL.invitee,
      o.role ?? "editor",
      digestOf(o.token),
      o.by ?? U.admin,
      o.expires ?? "1 day",
      o.used ?? false,
      U.admin,
      o.revoked ?? false,
    ],
  );
}

/** Runs one statement as the caller and commits it; the connection is always released, rolled back on failure. */
export async function commitAs(
  pool: Pool,
  user: string,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const client = await openTx(pool, asUser(user));
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export interface Attempt {
  rows?: Record<string, unknown>[];
  error?: unknown;
  after?: Record<string, unknown>[] | undefined;
}

/** Runs one statement as the caller in a transaction that is always rolled back; `after` reads the effect first. */
export async function attempt(
  pool: Pool,
  ctx: TenantCtx,
  sql: string,
  params: unknown[] = [],
  after?: [string, unknown[]?],
): Promise<Attempt> {
  const client = await openTx(pool, ctx);
  try {
    const rows = (await client.query(sql, params)).rows;
    return { rows, after: after ? (await client.query(after[0], after[1] ?? [])).rows : undefined };
  } catch (error) {
    return { error };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
