import { createHash, randomBytes } from "node:crypto";
import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import { enqueueMail } from "../../mail/enqueue.js";
import { type App, defineRoute } from "../define-route.js";
import { pageAnswer, pageQuery } from "../input.js";

// Invitations of one workspace: create (with its mail), list and revoke. Every change is a definer of migration 0010,
// which authorizes the caller; the route adds the throttle, the token and the mail (R243, R244, R255, R256, R258).

const workspaceId = z.uuid().transform((id) => id.toLowerCase());
const params = z.strictObject({ workspace_id: workspaceId });
const revokeParams = z.strictObject({ workspace_id: workspaceId, invitation_id: workspaceId });

const HOUR = 3600;
const MAX_EXPIRY = 14 * 24 * HOUR;
const create = z.strictObject({
  email: z.email().max(254),
  role_key: z.string().min(1).max(32),
  expires_in: z.number().int().min(HOUR).max(MAX_EXPIRY).optional(),
});

// The token is 32 random bytes in base64url: anything else is a malformed request, not a lookup.
const accept = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

const PAGE = 100;

// The caller's own workspace is not readable in a user-only transaction, so its name for the mail comes from the
// switcher definer, page by page (it lists the caller's reachable workspaces by id).
async function workspaceName(tx: TenantTx, id: string): Promise<string> {
  let after: string | null = null;
  for (;;) {
    const page: { rows: Array<{ workspace_id: string; name: string }> } = await tx.query(
      "SELECT workspace_id, name FROM app.my_workspaces($1, $2)",
      [PAGE, after],
    );
    const hit = page.rows.find((row) => row.workspace_id === id);
    if (hit) return hit.name;
    const last = page.rows[page.rows.length - 1];
    if (page.rows.length < PAGE || !last) throw new Error("workspace missing from the caller's list");
    after = last.workspace_id;
  }
}

interface Created {
  readonly workspace: string;
  readonly body: z.infer<typeof create>;
  readonly requestId: string;
  readonly ipHmac: Buffer;
}

// The invitation row and its mail are one transaction: a rollback sends nothing and a commit loses nothing (the outbox pattern).
async function createInvitation(
  auth: AuthService,
  inUserTx: <T>(run: (tx: TenantTx) => Promise<T>) => Promise<T>,
  input: Created,
) {
  const { workspace, body } = input;
  const token = randomBytes(32);
  const link = `${auth.publicOrigin}/invite/${token.toString("base64url")}`;
  const span = body.expires_in === undefined ? null : `${body.expires_in} seconds`;
  const id = await inUserTx(async (tx) => {
    const made = await tx.query<{ id: string }>(
      "SELECT app.invitation_create($1, $2, $3, $4::interval, $5, $6, $7) AS id",
      [
        workspace,
        body.email,
        body.role_key,
        span,
        createHash("sha256").update(token).digest(),
        input.requestId,
        input.ipHmac,
      ],
    );
    const newId = made.rows[0]?.id;
    if (!newId) throw new Error("invitation_create returned no id");
    const vars = { workspaceName: await workspaceName(tx, workspace), role: body.role_key };
    await enqueueMail(
      tx,
      { workspaceId: workspace, recipient: body.email, template: "invitation", locale: "en", vars, link },
      auth.mail,
    );
    return newId;
  });
  return { id, email: body.email.toLowerCase(), role_key: body.role_key };
}

export function registerInvitations(app: App, auth: AuthService): void {
  registerCreate(app, auth);
  registerAccept(app, auth);
  registerListAndRevoke(app, auth);
}

function registerCreate(app: App, auth: AuthService): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces/{workspace_id}/invitations",
    policy: "session",
    access: "user",
    status: 201,
    params,
    body: create,
    handler: async ({ c, params: path, body, clientAddress, inUserTx }) => {
      await auth.throttle.spend("invite", c.get("session").userId);
      await auth.throttle.spendIp("invite", clientAddress);
      return createInvitation(auth, inUserTx, {
        workspace: path.workspace_id,
        body,
        requestId: c.get("requestId"),
        ipHmac: auth.ipHmac(clientAddress),
      });
    },
  });
}

// The link opens the SPA page, which reads nothing; only this POST consumes the token (NFR-SEC-08). The guess
// throttle is per address, the account throttle per signed-in user.
function registerAccept(app: App, auth: AuthService): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/invitations/accept",
    policy: "session",
    access: "user",
    body: accept,
    handler: async ({ c, body, clientAddress, inUserTx }) => {
      await auth.throttle.spendIp("link_confirm", clientAddress);
      await auth.throttle.spend("invite_accept", c.get("session").userId);
      const digest = createHash("sha256").update(Buffer.from(body.token, "base64url")).digest();
      const joined = await inUserTx(async (tx) => {
        const found = await tx.query<{ id: string }>("SELECT app.invitation_accept($1, $2, $3) AS id", [
          digest,
          c.get("requestId"),
          auth.ipHmac(clientAddress),
        ]);
        const id = found.rows[0]?.id;
        if (!id) throw new Error("invitation_accept returned no id");
        return id;
      });
      return { workspace_id: joined };
    },
  });
}

function registerListAndRevoke(app: App, auth: AuthService): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/invitations",
    policy: "session",
    access: { workspace: "workspace_id", permission: "settings.manage" },
    params,
    query: pageQuery,
    handler: async ({ c, tx, scope, query }) => {
      const found = await tx.query<{ id: string }>(
        `SELECT i.id, i.email, r.key AS role_key, i.expires_at
         FROM app.invitations AS i JOIN app.roles AS r ON r.id = i.role_id
         WHERE i.workspace_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
           AND ($2::uuid IS NULL OR i.id > $2)
         ORDER BY i.id LIMIT $3`,
        [scope.workspaceId, query.cursor ?? null, query.limit],
      );
      return pageAnswer(c, found.rows, query.limit);
    },
  });
  defineRoute(app, {
    method: "delete",
    path: "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}",
    policy: "session",
    access: "user",
    params: revokeParams,
    handler: ({ c, params: path, clientAddress, inUserTx }) =>
      inUserTx(async (tx) => {
        await tx.query("SELECT app.invitation_revoke($1, $2, $3, $4)", [
          path.workspace_id,
          path.invitation_id,
          c.get("requestId"),
          auth.ipHmac(clientAddress),
        ]);
      }),
  });
}
