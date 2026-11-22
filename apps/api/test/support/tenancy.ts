import type { Fixture } from "../integration/auth/harness.js";

// Seeds tenancy rows through the admin client, which the runtime roles cannot do. Every organization keeps an owner
// (a deferred guard checks it at commit), so a new organization takes its owner's user id.

let counter = 0;
export const unique = (prefix: string): string => `${prefix}-${++counter}`;

export const workspacePath = (id: string): string => `/api/v1/workspaces/${id}`;

export async function userIdOf(fx: Fixture, email: string): Promise<string> {
  const found = await fx.admin((client) =>
    client.query('SELECT id FROM auth."user" WHERE email = $1', [email]),
  );
  return found.rows[0].id;
}

export async function seedOrganization(fx: Fixture, ownerId: string): Promise<string> {
  const slug = unique("org");
  return fx.admin(async (client) => {
    await client.query("BEGIN");
    const org = await client.query(
      "INSERT INTO app.organizations (name, slug, type) VALUES ($1, $1, 'team') RETURNING id",
      [slug],
    );
    await client.query(
      "INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, 'owner')",
      [org.rows[0].id, ownerId],
    );
    await client.query("COMMIT");
    return org.rows[0].id;
  });
}

export async function seedWorkspace(
  fx: Fixture,
  organizationId: string,
  name = unique("workspace"),
): Promise<string> {
  const found = await fx.admin((client) =>
    client.query(
      "INSERT INTO app.workspaces (organization_id, name, slug) VALUES ($1, $2, $2) RETURNING id",
      [organizationId, name],
    ),
  );
  return found.rows[0].id;
}

export async function addWorkspaceMember(
  fx: Fixture,
  workspaceId: string,
  userId: string,
  roleKey: string,
  status: "active" | "suspended" = "active",
): Promise<void> {
  // A workspace keeps exactly one stored Owner (a deferred guard checks it at commit): a member who is not the Owner
  // brings a suspended placeholder Owner when there is none, and the Owner replaces that placeholder.
  const OWNER = "r.workspace_id IS NULL AND r.key = 'owner'";
  await fx.admin(async (client) => {
    await client.query("BEGIN");
    if (roleKey === "owner") {
      await client.query(
        `DELETE FROM app.workspace_members m USING app.roles r, auth."user" u
         WHERE m.workspace_id = $1 AND r.id = m.role_id AND ${OWNER} AND u.id = m.user_id
           AND u.email LIKE 'placeholder-owner-%'`,
        [workspaceId],
      );
    }
    await client.query(
      `INSERT INTO app.workspace_members (workspace_id, user_id, role_id, status)
       SELECT $1, $2, id, $4 FROM app.roles WHERE workspace_id IS NULL AND key = $3`,
      [workspaceId, userId, roleKey, status],
    );
    const owned = await client.query(
      `SELECT 1 FROM app.workspace_members m JOIN app.roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND ${OWNER}`,
      [workspaceId],
    );
    if (owned.rowCount === 0) {
      const email = `placeholder-owner-${unique("ws")}@example.test`;
      const holder = await client.query(
        'INSERT INTO auth."user" (name, email) VALUES ($1, $1) RETURNING id',
        [email],
      );
      await client.query(
        `INSERT INTO app.workspace_members (workspace_id, user_id, role_id, status)
         SELECT $1, $2, id, 'suspended' FROM app.roles WHERE workspace_id IS NULL AND key = 'owner'`,
        [workspaceId, holder.rows[0].id],
      );
    }
    await client.query("COMMIT");
  });
}

export async function addOrganizationMember(
  fx: Fixture,
  organizationId: string,
  userId: string,
  orgRole: string,
): Promise<void> {
  await fx.admin((client) =>
    client.query(
      "INSERT INTO app.organization_members (organization_id, user_id, org_role) VALUES ($1, $2, $3)",
      [organizationId, userId, orgRole],
    ),
  );
}

/** Plants one channel row in any state; connect definers do not exist yet, so the superuser writes it. */
export async function seedChannel(
  fx: Fixture,
  workspaceId: string,
  state = "connected",
  displayName = unique("channel"),
  providerId = "fixture-oauth",
): Promise<string> {
  const found = await fx.admin((client) =>
    client.query(
      `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name,
         connection_state, state_reason)
       VALUES ($1, $4::text, 'profile', $2::text, $2::text, $3::text,
         CASE WHEN $3::text = 'disabled' THEN 'admin_disabled' END)
       RETURNING id`,
      [workspaceId, displayName, state, providerId],
    ),
  );
  return found.rows[0].id;
}

export async function workspaceRow(fx: Fixture, id: string): Promise<Record<string, unknown>> {
  const found = await fx.admin((client) =>
    client.query("SELECT name, slug, colour, default_tz FROM app.workspaces WHERE id = $1", [id]),
  );
  return found.rows[0];
}

/** Signs up a user and returns its id and session cookie. */
export async function signedUser(fx: Fixture, label: string): Promise<{ id: string; cookie: string }> {
  const email = `${unique(label)}@example.test`;
  const cookie = await fx.signedIn(email);
  return { id: await userIdOf(fx, email), cookie };
}
