import { createBlueskyAdapter } from "@shoutory/provider-bluesky/adapter";
import { blueskyManifest } from "@shoutory/provider-bluesky/manifest";
import { createDiscordAdapter } from "@shoutory/provider-discord/adapter";
import { discordManifest } from "@shoutory/provider-discord/manifest";
import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import { createTelegramAdapter } from "@shoutory/provider-telegram/adapter";
import { telegramManifest } from "@shoutory/provider-telegram/manifest";

export const builtInManifests: readonly unknown[] = [
  blueskyManifest,
  discordManifest,
  mastodonManifest,
  telegramManifest,
];

export const createBuiltInAdapters = (): AdapterMap => ({
  [blueskyManifest.id]: createBlueskyAdapter(),
  [discordManifest.id]: createDiscordAdapter(),
  [mastodonManifest.id]: createMastodonAdapter(),
  [telegramManifest.id]: createTelegramAdapter(),
});
