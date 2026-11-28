// What the e2e simulators answer for. No imports, so Node can load this file as it is (the contract test does) and the
// bundle that runs in the simulators container reads the same table the certificates and the compose aliases come from.

export const MASTODON_HOST = "social.test";

// The Bluesky simulator's documents name these hosts themselves (its handle, PDS, authorization server and web DID), and
// the adapter follows what they say, so the names cannot be chosen here.
export const SIMULATOR_HOSTS = {
  telegram: ["api.telegram.org"],
  discord: ["discord.com"],
  mastodon: [MASTODON_HOST],
  bluesky: ["alice.example", "bob.example", "pds.example", "auth.example", "plc.directory"],
} as const;

export const ALL_HOSTS: readonly string[] = Object.values(SIMULATOR_HOSTS).flat();
