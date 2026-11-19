import { ENTITLEMENT_KEYS, type Entitlements } from "@shoutory/core/entitlements";
import { z } from "zod";
import { type App, defineRoute } from "../define-route.js";

// The plan limits of one workspace, read by any member (the billing page shows them): one entry per key of the core
// list, each copied field by field so an implementation's extra fields never reach the answer. A workspace the caller
// does not reach answers like one that does not exist (the access rule of the route).

const params = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

// What an implementation returns is parsed, not trusted: an unknown kind throws (the route answers 500) instead of
// reading as unlimited, and a field outside the schema is dropped.
const shown = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unlimited") }),
  z.object({ kind: z.literal("limited"), limit: z.number(), used: z.number() }),
]);

export function registerEntitlements(app: App, entitlements: Entitlements): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/entitlements",
    policy: "session",
    access: { workspace: "workspace_id" },
    params,
    handler: async ({ scope }) => {
      const checked = await Promise.all(
        ENTITLEMENT_KEYS.map(async (key) => [
          key,
          shown.parse(await entitlements.check(scope.workspaceId, key)),
        ]),
      );
      return Object.fromEntries(checked);
    },
  });
}
