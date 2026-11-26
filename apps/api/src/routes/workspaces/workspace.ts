import type { TenantTx } from "@shoutory/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import { Refusal } from "../../errors/refusal.js";
import { type App, type AppEnv, defineRoute, type InUserTx } from "../define-route.js";
import { definerRefusal } from "../definer-refusal.js";
import { createdAnswer, createKey, nameSchema, pageAnswer, pageQuery } from "../input.js";

// Lowercased, as the tenant context does, so the caller's own workspace is found whatever the case of its id.
const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

const ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const defaultTz = z.string().refine((zone) => ZONES.has(zone), "unknown time zone");
const lowerId = z.uuid().transform((id) => id.toLowerCase());
const profile = z
  .strictObject({
    name: nameSchema,
    slug,
    colour: z.string().regex(/^#[0-9a-f]{6}$/),
    default_tz: defaultTz,
    avatar: lowerId.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "at least one field");

// The organization and the template are body fields, checked by the definer, which answers a foreign and a missing
// one alike. The template gives the zone only when the body names none.
const create = z
  .strictObject({
    organization_id: lowerId,
    name: nameSchema,
    slug: slug.optional(),
    default_tz: defaultTz.optional(),
    template_workspace_id: lowerId.optional(),
  })
  .refine(
    (body) => body.default_tz !== undefined || body.template_workspace_id !== undefined,
    "a zone or a template",
  );

function slugOf(name: string): string {
  const derived = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63);
  return derived === "" ? "workspace" : derived;
}

const COLUMNS = ["name", "slug", "colour", "default_tz"] as const;
const ANSWER = "id, organization_id, name, slug, colour, default_tz, archived_at, avatar";

async function read(tx: TenantTx, id: string) {
  const found = await tx.query(`SELECT ${ANSWER} FROM app.workspaces WHERE id = $1`, [id]);
  if (!found.rows[0]) throw new Refusal("not_found", "workspace row not visible");
  return found.rows[0];
}

async function setAvatar(tx: TenantTx, id: string, avatar: string | null) {
  try {
    await tx.query("SELECT app.workspace_avatar_set($1, $2)", [id, avatar]);
  } catch (error) {
    throw definerRefusal(error) ?? error;
  }
}

async function update(tx: TenantTx, id: string, body: z.infer<typeof profile>) {
  if (body.avatar !== undefined) await setAvatar(tx, id, body.avatar);
  const changed = COLUMNS.filter((column) => body[column] !== undefined);
  if (changed.length === 0) return read(tx, id);
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

function attemptOf(base: string, attempt: number): string {
  if (attempt === 1) return base;
  const suffix = `-${attempt}`;
  return base.slice(0, 63 - suffix.length).replace(/-+$/, "") + suffix;
}

type Audit = { requestId: string; ipHmac: Buffer; bucketKey: string; key: string | null };
type Made = { id: string; slug: string; colour: string | null; default_tz: string; replayed: boolean };

// One attempt is its own transaction: a clash aborts it, and the next try starts clean.
const insertWorkspace = (inUserTx: InUserTx, body: z.infer<typeof create>, slugValue: string, audit: Audit) =>
  inUserTx(async (tx) => {
    const made = await tx.query<Made>(
      "SELECT id, slug, colour, default_tz, replayed FROM app.workspace_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        body.organization_id,
        body.name,
        slugValue,
        body.default_tz ?? null,
        audit.requestId,
        audit.ipHmac,
        audit.bucketKey,
        audit.key,
        body.template_workspace_id ?? null,
        body.slug !== undefined,
      ],
    );
    const row = made.rows[0];
    if (!row) throw new Error("workspace_create returned no row");
    return row;
  });

// A slug the caller chose that is taken is a conflict; a slug derived from the name is tried again with a number until
// one is free. A retry with the same key answers the stored row with 200.
async function createWorkspace(
  c: Context<AppEnv>,
  inUserTx: InUserTx,
  body: z.infer<typeof create>,
  audit: Audit,
) {
  const base = slugOf(body.name);
  const tries = body.slug
    ? [body.slug]
    : Array.from({ length: MAX_ATTEMPTS }, (_, at) => attemptOf(base, at + 1));
  let clash: unknown;
  for (const chosen of tries) {
    try {
      const { replayed, ...made } = await insertWorkspace(inUserTx, body, chosen, audit);
      return createdAnswer(c, { ...made, organization_id: body.organization_id, name: body.name }, replayed);
    } catch (error) {
      if (!isSlugClash(error)) throw error;
      clash = error;
    }
  }
  throw new Refusal("conflict", "slug already used in the organization", { cause: clash });
}

// The definer checks the caller's rank and answers a foreign and a missing workspace alike; a repeat is a no-op.
function registerArchive(app: App, auth: Pick<AuthService, "ipHmac">, action: "archive" | "unarchive"): void {
  defineRoute(app, {
    method: "post",
    path: `/api/v1/workspaces/{workspace_id}/${action}`,
    policy: "session",
    access: "user",
    params,
    handler: ({ c, params: { workspace_id }, clientAddress, inUserTx }) =>
      inUserTx(async (tx) => {
        const done = await tx.query<{ archived_at: Date | null }>(
          `SELECT app.workspace_${action}($1, $2, $3) AS archived_at`,
          [workspace_id, c.get("requestId"), auth.ipHmac(clientAddress)],
        );
        return { id: workspace_id, archived_at: done.rows[0]?.archived_at ?? null };
      }),
  });
}

export function registerWorkspaces(app: App, auth: Pick<AuthService, "ipHmac" | "bucketKey">): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces",
    policy: "session",
    access: "user",
    query: pageQuery,
    handler: async ({ c, query, inUserTx }) => {
      const rows = await inUserTx(async (tx) => {
        const found = await tx.query<{ id: string }>(
          `SELECT workspace_id AS id, organization_id, name, slug, role_key AS role, archived_at, avatar, organization_type
             FROM app.my_workspaces($1, $2)`,
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
      createWorkspace(c, inUserTx, body, {
        requestId: c.get("requestId"),
        ipHmac: auth.ipHmac(clientAddress),
        bucketKey: auth.bucketKey("tenant_create", c.get("session").userId),
        key: createKey(c),
      }),
  });
  for (const action of ["archive", "unarchive"] as const) registerArchive(app, auth, action);
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
