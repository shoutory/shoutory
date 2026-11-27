import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// Docs only until a live run records the answers: every number is what the cited page says and none was measured.
const POST_LEXICON =
  "https://github.com/bluesky-social/social-app/blob/main/lexicons/app/bsky/feed/post.json";
const IMAGES_LEXICON =
  "https://github.com/bluesky-social/social-app/blob/main/lexicons/app/bsky/embed/images.json";
const CHECKED = "2026-11-27";

export const blueskyManifest = manifestSchema.parse({
  id: "bluesky",
  displayName: "Bluesky",
  lifecycle: "beta",
  auth: { method: "oauth2_pkce" },
  scopes: ["atproto", "transition:generic"],
  capabilities: ["text", "image", "thread", "first_comment", "delete", "refresh"],
  readBackMode: "A",
  // The record key is chosen by the client, so a lost answer is settled by reading that key back (what a repeated key does is not yet measured).
  idempotency: { mechanism: "natural_key", keyWindowSeconds: 0, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "read_back_first", readBack: "safe", delete: "safe" },
  // 5,000 points per hour and 3 points per created record (docs.bsky.app rate limits): 1,666 creates.
  rateLimits: [{ name: "writes", scope: "account", key: "account", max: 1666, windowSeconds: 3600 }],
  actionWindows: {},
  egressHostSource: "open",
  followUpRoles: ["thread_reply", "first_comment"],
  leaseSeconds: { prepare: 60, commit: 120, readBack: 60, delete: 60 },
  callTimeoutSeconds: 30,
  uploadTimeoutSeconds: 120,
  retryAfterMaxSeconds: 900,
  dispatchMarginSeconds: 300,
  maxInFlightSeconds: 60,
  readBackGapSeconds: 30,
  maxAttempts: 5,
  unverifiedHorizonDays: 30,
  clockSkewSeconds: 120,
  concurrency: 4,
  refreshErrorMap: { invalid_grant: "revoked" },
  absentAnswers: [{ status: 404 }],
  counting: { unit: "graphemes" },
  apiAccess: "official",
  apiVersions: [],
  limits: {
    textLength: { value: 300, source: POST_LEXICON, checked: CHECKED },
    textBytes: { value: 3000, source: POST_LEXICON, checked: CHECKED },
    mediaMaxCount: { value: 4, source: IMAGES_LEXICON, checked: CHECKED },
    imageMaxBytes: { value: 2_000_000, source: IMAGES_LEXICON, checked: CHECKED },
  },
});
