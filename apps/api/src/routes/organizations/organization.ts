import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import { type App, defineRoute } from "../define-route.js";
import { nameSchema, pageAnswer, pageQuery } from "../input.js";

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
        const made = await tx.query<{ id: string }>(
          "SELECT app.organization_create($1, $2, $3, $4, $5) AS id",
          [
            body.name,
            body.type,
            c.get("requestId"),
            auth.ipHmac(clientAddress),
            auth.bucketKey("tenant_create", c.get("session").userId),
          ],
        );
        const id = made.rows[0]?.id;
        if (!id) throw new Error("organization_create returned no id");
        // The row is not readable here (no organization context yet); the definer derives the slug from the id.
        return { id, name: body.name, slug: `o-${id.replaceAll("-", "")}`, type: body.type };
      }),
  });
}
