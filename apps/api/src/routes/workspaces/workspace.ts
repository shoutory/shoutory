import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute, type InUserTx } from "../define-route.js";
import { nameSchema, pageAnswer, pageQuery } from "../input.js";

// The profile of one workspace: any member reads it (the switcher and the settings page show its name), and a role
// with settings.manage changes it. The workspace id is the path parameter and nothing else (R205, R214).

// Lowercased, as the tenant context does, so the caller's own workspace is found whatever the case of its id.
const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

const ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

// The bounds are those of the workspaces columns (migration 0007).
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const defaultTz = z.string().refine((zone) => ZONES.has(zone), "unknown time zone");
const profile = z
  .strictObject({ name: nameSchema, slug, colour: z.string().regex(/^#[0-9a-f]{6}$/), default_tz: defaultTz })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field");

// The first workspace's slug is optional: it comes from the name (R231). The organization is a body field, checked by
// the definer, which answers a foreign and a missing one alike.
const create = z.strictObject({
  organization_id: z.uuid().transform((id) => id.toLowerCase()),
  name: nameSchema,
  slug: slug.optional(),
  default_tz: defaultTz,
});

/** Lowercase, every run outside a-z and 0-9 as one dash, trimmed, cut to 63; `workspace` when nothing is left. */
function slugOf(name: string): string {
  const derived = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63);
  return derived === "" ? "workspace" : derived;
}

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

const isSlugClash = (error: unknown) =>
  (error as { constraint?: unknown }).constraint === "workspaces_organization_slug_key";

// The organization holds at most 100 workspaces, so no derived slug needs more than 100 tries.
const MAX_ATTEMPTS = 100;

/** The nth try of a derived slug: the base, then `base-2`, `base-3`, the base cut so the whole stays within 63. */
function attemptOf(base: string, attempt: number): string {
  if (attempt === 1) return base;
  const suffix = `-${attempt}`;
  return base.slice(0, 63 - suffix.length).replace(/-+$/, "") + suffix;
}

type Audit = { requestId: string; ipHmac: Buffer };

// One attempt is its own transaction: a clash aborts it, and the next try starts clean.
const insertWorkspace = (inUserTx: InUserTx, body: z.infer<typeof create>, slugValue: string, audit: Audit) =>
  inUserTx(async (tx) => {
    const made = await tx.query<{ id: string }>("SELECT app.workspace_create($1, $2, $3, $4, $5, $6) AS id", [
      body.organization_id,
      body.name,
      slugValue,
      body.default_tz,
      audit.requestId,
      audit.ipHmac,
    ]);
    const newId = made.rows[0]?.id;
    if (!newId) throw new Error("workspace_create returned no id");
    return newId;
  });

// The caller's own new row is not readable here (no workspace context yet), so the answer is built from the input and
// the id the definer returned; the colour is null until someone sets it. A slug the caller chose that is taken is a
// conflict; a slug derived from the name is tried again with a number until one is free.
async function createWorkspace(inUserTx: InUserTx, body: z.infer<typeof create>, audit: Audit) {
  const base = slugOf(body.name);
  const tries = body.slug
    ? [body.slug]
    : Array.from({ length: MAX_ATTEMPTS }, (_, at) => attemptOf(base, at + 1));
  let clash: unknown;
  for (const chosen of tries) {
    try {
      const id = await insertWorkspace(inUserTx, body, chosen, audit);
      return {
        id,
        organization_id: body.organization_id,
        name: body.name,
        slug: chosen,
        colour: null,
        default_tz: body.default_tz,
      };
    } catch (error) {
      if (!isSlugClash(error)) throw error;
      clash = error;
    }
  }
  throw new Refusal("conflict", "slug already used in the organization", { cause: clash });
}

export function registerWorkspaces(app: App, ipHmac: (address: string) => Buffer): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces",
    policy: "session",
    access: "user",
    query: pageQuery,
    handler: async ({ c, query, inUserTx }) => {
      const rows = await inUserTx(async (tx) => {
        const found = await tx.query<{ id: string }>(
          "SELECT workspace_id AS id, organization_id, name, slug, role_key AS role FROM app.my_workspaces($1, $2)",
          [query.limit, query.cursor ?? null],
        );
        return found.rows;
      });
      return pageAnswer(c, rows, query.limit);
    },
  });
  defineRoute(app, {
    method: "post",
    path: "/api/v1/workspaces",
    policy: "session",
    access: "user",
    status: 201,
    body: create,
    handler: ({ c, body, clientAddress, inUserTx }) =>
      createWorkspace(inUserTx, body, { requestId: c.get("requestId"), ipHmac: ipHmac(clientAddress) }),
  });
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
