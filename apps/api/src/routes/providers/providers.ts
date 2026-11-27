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

// Accounts on servers a person names are found from the account typed, not from a host.
const needsLoginHint = ({ manifest }: HealthProvider) => manifest.egressHostSource === "open";

// What a person pastes instead of authorizing, for the providers whose credential is a secret they hold.
const secretKind = ({ manifest }: HealthProvider) =>
  manifest.auth.method === "bot_token" || manifest.auth.method === "webhook_url"
    ? manifest.auth.method
    : null;

// A provider whose server fetches documents from this app can only connect when the app is reachable over public https.
function needsPublicOrigin({ adapter }: HealthProvider, publicOrigin: string): boolean {
  if (adapter.connect?.publicDocuments === undefined) return false;
  const { protocol, hostname } = new URL(publicOrigin);
  return protocol !== "https:" || hostname === "localhost" || hostname.endsWith(".localhost");
}

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
        needs_login_hint: needsLoginHint(provider),
        secret_kind: secretKind(provider),
        needs_public_origin: needsPublicOrigin(provider, publicOrigin),
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
