import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";

// The profile of one workspace: any member reads it (the switcher and the settings page show its name), and a role
// with settings.manage changes it. The workspace id is the path parameter and nothing else (R205, R214).

// Lowercased, as the tenant context does, so the caller's own workspace is found whatever the case of its id.
const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

const ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

// The bounds are those of the workspaces columns (migration 0007).
const profile = z
  .strictObject({
    // PostgreSQL text cannot hold U+0000 (it would answer 22021).
    name: z
      .string()
      .min(1)
      .max(128)
      .refine((name) => !name.includes("\0"), "no NUL character"),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    colour: z.string().regex(/^#[0-9a-f]{6}$/),
    default_tz: z.string().refine((zone) => ZONES.has(zone), "unknown time zone"),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field");

const COLUMNS = ["name", "slug", "colour", "default_tz"] as const;
const ANSWER = "id, organization_id, name, slug, colour, default_tz";

async function read(tx: TenantTx, id: string) {
  const found = await tx.query(`SELECT ${ANSWER} FROM app.workspaces WHERE id = $1`, [id]);
  if (!found.rows[0]) throw new Refusal("not_found", "workspace row not visible");
  return found.rows[0];
}

async function update(
  tx: TenantTx,
  id: string,
  body: Partial<Record<(typeof COLUMNS)[number], string | undefined>>,
) {
  const changed = COLUMNS.filter((column) => body[column] !== undefined);
  const sets = changed.map((column, index) => `${column} = $${index + 2}`);
  try {
    const found = await tx.query(
      `UPDATE app.workspaces SET ${sets.join(", ")} WHERE id = $1 RETURNING ${ANSWER}`,
      [id, ...changed.map((column) => body[column])],
    );
    if (!found.rows[0]) throw new Refusal("not_found", "workspace row not updated");
    return found.rows[0];
  } catch (error) {
    const clash =
      (error as { code?: unknown; constraint?: unknown }).constraint === "workspaces_organization_slug_key";
    if (clash) throw new Refusal("conflict", "slug already used in the organization", { cause: error });
    throw error;
  }
}

export function registerWorkspaces(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}",
    policy: "session",
    access: { workspace: "workspace_id" },
    params,
    handler: ({ tx, scope }) => read(tx, scope.workspaceId),
  });
  defineRoute(app, {
    method: "patch",
    path: "/api/v1/workspaces/{workspace_id}",
    policy: "session",
    access: { workspace: "workspace_id", permission: "settings.manage" },
    params,
    body: profile,
    handler: ({ tx, scope, body }) => update(tx, scope.workspaceId, body),
  });
}
