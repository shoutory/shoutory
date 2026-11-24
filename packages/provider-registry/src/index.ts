import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";

// The one list of the providers built into this product: each provider slice adds its manifest and its adapter here, and
// nothing else names a provider. The manifests are validated by `createRegistry` where they are used.
export const builtInManifests: readonly unknown[] = [mastodonManifest];

/** A new adapter of every built-in provider, by provider id. */
export const createBuiltInAdapters = (): AdapterMap => ({
  [mastodonManifest.id]: createMastodonAdapter(),
});
