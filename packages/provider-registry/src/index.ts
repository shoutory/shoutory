import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";

export const builtInManifests: readonly unknown[] = [mastodonManifest];

export const createBuiltInAdapters = (): AdapterMap => ({
  [mastodonManifest.id]: createMastodonAdapter(),
});
