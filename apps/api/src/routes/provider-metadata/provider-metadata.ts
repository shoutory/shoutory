import type { KeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { ConnectAdapter } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import type { HealthProvider } from "../../channels/health.js";
import { readProviderApp } from "../../channels/provider-app.js";
import { Refusal } from "../../errors/refusal.js";
import { type App, defineRoute } from "../define-route.js";

type Providers = Readonly<Record<string, HealthProvider>>;

const CACHE = "public, max-age=300";
const DERIVED_MS = 60_000;
// The members of a key that only its holder may know (RFC 7518 sections 6.2.2, 6.3.2 and 6.4): the answer never carries
// them, whatever a document says.
const PRIVATE_MEMBERS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

function withoutPrivateKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrivateKeys);
  if (typeof value !== "object" || value === null) return value;
  const isKey = "kty" in value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !(isKey && PRIVATE_MEMBERS.has(name)))
      .map(([name, member]) => [name, withoutPrivateKeys(member)]),
  );
}

// The documents a provider's server fetches from this app (client metadata, key set). Anyone may read them, so the route
// serves only the names the adapter publishes and nothing it holds privately.
export function registerProviderMetadata(
  app: App,
  providers: Providers,
  publicOrigin: string,
  store: { readonly pool: AppPool; readonly keys: KeyProvider; readonly now: () => number },
): void {
  const { now } = store;
  // One entry per registered provider at most, and it lives a minute: a flood of reads derives the documents (which
  // unseals the app) once, not once per request.
  const derived = new Map<
    string,
    { readonly until: number; readonly documents: Readonly<Record<string, unknown>> }
  >();
  async function documentsOf(providerId: string, connect: ConnectAdapter | undefined) {
    const kept = derived.get(providerId);
    if (kept !== undefined && kept.until > now()) return kept.documents;
    // Only a provider whose app is the instance's has one to build its documents from.
    const stored =
      connect?.appKind === "provider"
        ? await withSystem(store.pool, "provider_documents", (tx) =>
            readProviderApp(tx, store.keys, providerId, null),
          )
        : undefined;
    const documents = await connect?.publicDocuments?.({
      publicOrigin,
      ...(stored === undefined ? {} : { app: stored }),
    });
    if (documents === undefined) return undefined;
    const clean = withoutPrivateKeys(documents) as Readonly<Record<string, unknown>>;
    // Documents built before the provider's app exists are the wrong ones and must not outlive its registration.
    if (connect?.appKind !== "provider" || stored !== undefined) {
      derived.set(providerId, { until: now() + DERIVED_MS, documents: clean });
    }
    return clean;
  }
  defineRoute(app, {
    method: "get",
    path: "/api/v1/provider-documents/{provider_id}/{name}",
    policy: "public",
    access: "none",
    params: z.strictObject({
      provider_id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    }),
    handler: async ({ c, params }) => {
      const provider = Object.hasOwn(providers, params.provider_id)
        ? providers[params.provider_id]
        : undefined;
      const documents = provider
        ? await documentsOf(params.provider_id, provider.adapter.connect)
        : undefined;
      if (documents === undefined || !Object.hasOwn(documents, params.name)) {
        throw new Refusal("not_found", "no such document");
      }
      c.header("cache-control", CACHE);
      return c.json(documents[params.name]);
    },
  });
}
