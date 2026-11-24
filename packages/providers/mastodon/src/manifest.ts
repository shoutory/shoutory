import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// Every number below names the page it was read from and the day it was read (docs.joinmastodon.org, 2026-11-24). A
// number an instance states itself (`GET /api/v2/instance`) replaces the default here when a channel connects and
// whenever its health is read, so these are only what the documentation says an unmodified instance allows.
const INSTANCE_DOCS = "https://docs.joinmastodon.org/methods/instance/";
const CHECKED = "2026-11-24";

/**
 * The manifest of the Mastodon network. Its accounts live on user-chosen servers, so its host is the channel's own stored
 * instance (`egressHostSource`), never a list. A channel can be connected and its limits and health read, but no
 * capability is declared until publishing ships, so post validation refuses a target on it; each capability (text, media,
 * edit, threads) is declared as it ships.
 */
export const mastodonManifest = manifestSchema.parse({
  id: "mastodon",
  displayName: "Mastodon",
  lifecycle: "beta",
  auth: { method: "oauth2_pkce" },
  // read:accounts for verify_credentials, write:statuses to post and delete, write:media for uploads.
  scopes: ["read:accounts", "write:statuses", "write:media"],
  capabilities: [],
  readBackMode: "A",
  // The native Idempotency-Key (docs.joinmastodon.org/methods/statuses/, "stored for up to 1 hour"). VERIFY: the window is
  // measured on a live instance before a resend is ever allowed (V-58), so a resend after an unknown outcome waits for a
  // read-back.
  idempotency: { mechanism: "header", keyWindowSeconds: 3600, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "read_back_first", readBack: "safe" },
  // 300 calls per 5 minutes per account and 30 media uploads per 30 minutes (PF-M09; docs.joinmastodon.org/api/rate-limits/,
  // read 2026-11-24).
  rateLimits: [
    { name: "api", scope: "account", key: "account", max: 300, windowSeconds: 300 },
    { name: "media", scope: "account", key: "account", max: 30, windowSeconds: 1800 },
  ],
  actionWindows: {},
  egressHostSource: "channel",
  followUpRoles: [],
  leaseSeconds: { prepare: 60, commit: 120, readBack: 60 },
  callTimeoutSeconds: 30,
  retryAfterMaxSeconds: 900,
  dispatchMarginSeconds: 300,
  maxInFlightSeconds: 60,
  readBackGapSeconds: 30,
  maxAttempts: 5,
  unverifiedHorizonDays: 30,
  clockSkewSeconds: 120,
  concurrency: 4,
  // An access token does not expire and there is no refresh token, so nothing is ever refreshed.
  refreshErrorMap: {},
  absentAnswers: [{ status: 404 }],
  // The instance counts code points, and a link counts `characters_reserved_per_url` whatever its length.
  counting: { unit: "weighted", urlWeight: 23, weights: { defaultWeight: 1, ranges: [] } },
  apiAccess: "official",
  apiVersions: [
    // VERIFY: `introduced` is the release date of 4.0.0, the first version with the v2 instance answer (GitHub releases).
    { version: "v2", introduced: "2022-11-18", docsUrl: INSTANCE_DOCS, checked: CHECKED },
  ],
  limits: {
    textLength: { value: 500, source: INSTANCE_DOCS, checked: CHECKED },
    urlWeight: { value: 23, source: INSTANCE_DOCS, checked: CHECKED },
    mediaMaxCount: { value: 4, source: INSTANCE_DOCS, checked: CHECKED },
    imageMaxBytes: { value: 10_485_760, source: INSTANCE_DOCS, checked: CHECKED },
  },
});
