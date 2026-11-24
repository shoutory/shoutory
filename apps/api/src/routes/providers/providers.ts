import { z } from "zod";
import type { HealthProvider } from "../../channels/health.js";
import { type App, defineRoute } from "../define-route.js";

// The answer is an allowlist: nothing of a manifest's scopes, hosts or limits, and nothing of the adapter, leaves the
// server.

const workspaceParams = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

export function registerProviders(app: App, providers: Readonly<Record<string, HealthProvider>>): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/providers",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.view" },
    params: workspaceParams,
    handler: () =>
      Object.entries(providers)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, { adapter, manifest }]) => ({
          id,
          display_name: manifest.displayName,
          lifecycle: manifest.lifecycle,
          auth_kind: manifest.auth.method,
          connectable: adapter.connect !== undefined,
        })),
  });
}
