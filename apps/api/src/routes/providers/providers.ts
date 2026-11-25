import { z } from "zod";
import { redirectUriOf } from "../../channels/connect.js";
import type { HealthProvider } from "../../channels/health.js";
import { asAdmin } from "../admin/admin.js";
import { type App, defineRoute } from "../define-route.js";

// The answers are allowlists: nothing of a manifest's scopes, hosts or limits, and nothing of the adapter, leaves the
// server.

type Providers = Readonly<Record<string, HealthProvider>>;

const workspaceParams = z.strictObject({ workspace_id: z.uuid().transform((id) => id.toLowerCase()) });

const sorted = (providers: Providers) => Object.entries(providers).sort(([a], [b]) => (a < b ? -1 : 1));

// A provider whose accounts live on servers people choose needs the host typed before the connect.
const needsInstanceHost = ({ manifest }: HealthProvider) => manifest.egressHostSource === "channel";

export function registerProviders(app: App, providers: Providers, publicOrigin: string): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/workspaces/{workspace_id}/providers",
    policy: "session",
    access: { workspace: "workspace_id", permission: "channels.view" },
    params: workspaceParams,
    handler: () =>
      sorted(providers).map(([id, provider]) => ({
        id,
        display_name: provider.manifest.displayName,
        lifecycle: provider.manifest.lifecycle,
        auth_kind: provider.manifest.auth.method,
        connectable: provider.adapter.connect !== undefined,
        needs_instance_host: needsInstanceHost(provider),
      })),
  });
  defineRoute(app, {
    method: "get",
    path: "/api/v1/admin/providers",
    policy: "session",
    access: "user",
    handler: ({ inUserTx }) =>
      asAdmin(inUserTx, async () =>
        sorted(providers).map(([id, provider]) => ({
          id,
          display_name: provider.manifest.displayName,
          lifecycle: provider.manifest.lifecycle,
          auth_kind: provider.manifest.auth.method,
          needs_instance_host: needsInstanceHost(provider),
          // An instance provider registers its app on each server as it connects, so there is no one URI to register.
          redirect_uri: needsInstanceHost(provider) ? null : redirectUriOf(publicOrigin, id),
        })),
      ),
  });
}
