import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import { type App, defineRoute } from "../define-route.js";
import { createdAnswer, createKey, nameSchema, pageAnswer, pageQuery } from "../input.js";

const create = z.strictObject({ name: nameSchema, type: z.enum(["agency", "team", "personal"]) });

export function registerOrganizations(app: App, auth: Pick<AuthService, "ipHmac" | "bucketKey">): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/organizations",
    policy: "session",
    access: "user",
    query: pageQuery,
    handler: async ({ c, query, inUserTx }) => {
      const rows = await inUserTx(async (tx) => {
        const found = await tx.query<{ id: string }>(
          "SELECT organization_id AS id, name, slug, type, org_role FROM app.my_organizations($1, $2)",
          [query.limit, query.cursor ?? null],
        );
        return found.rows;
      });
      return pageAnswer(c, rows, query.limit);
    },
  });
  defineRoute(app, {
    method: "post",
    path: "/api/v1/organizations",
    policy: "session",
    access: "user",
    status: 201,
    body: create,
    handler: ({ c, body, clientAddress, inUserTx }) =>
      inUserTx(async (tx) => {
        const made = await tx.query<{ id: string; replayed: boolean }>(
          "SELECT id, replayed FROM app.organization_create($1, $2, $3, $4, $5, $6)",
          [
            body.name,
            body.type,
            c.get("requestId"),
            auth.ipHmac(clientAddress),
            auth.bucketKey("tenant_create", c.get("session").userId),
            createKey(c),
          ],
        );
        const row = made.rows[0];
        if (!row) throw new Error("organization_create returned no row");
        // The row is not readable here (no organization context yet); the definer derives the slug from the id.
        const data = {
          id: row.id,
          name: body.name,
          slug: `o-${row.id.replaceAll("-", "")}`,
          type: body.type,
        };
        return createdAnswer(c, data, row.replayed);
      }),
  });
}
