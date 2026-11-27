import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// A number an instance states itself (`GET /api/v2/instance`) replaces the default here when a channel connects and
// whenever its health is read, so these are only what the documentation says an unmodified instance allows.
const INSTANCE_DOCS = "https://docs.joinmastodon.org/methods/instance/";
const CHECKED = "2026-11-24";

export const mastodonManifest = manifestSchema.parse({
  id: "mastodon",
  displayName: "Mastodon",
  lifecycle: "beta",
  auth: { method: "oauth2_pkce" },
  // read:accounts for verify_credentials, read:statuses so a read-back sees private and direct posts, write:statuses to
  // post and delete, write:media for uploads.
  scopes: ["read:accounts", "read:statuses", "write:statuses", "write:media"],
  capabilities: ["text", "image", "video", "delete"],
  readBackMode: "A",
  // The native Idempotency-Key (docs.joinmastodon.org/methods/statuses/, "stored for up to 1 hour"). VERIFY: the window is
  // measured on a live instance before a resend is ever allowed, so a resend after an unknown outcome waits for a
  // read-back.
  idempotency: { mechanism: "header", keyWindowSeconds: 3600, resendAfterUnknown: "read_back_only" },
  // A delete whose outcome is unknown is never sent again on its own: a 404 is confirmed by a read, and a status that is
  // still there after one is an unknown outcome for a person to decide.
  retrySafety: { prepare: "safe", commit: "read_back_first", readBack: "safe", delete: "never" },
  // 300 calls per 5 minutes per account and 30 media uploads per 30 minutes (docs.joinmastodon.org/api/rate-limits/,
  // read 2026-11-24).
  rateLimits: [
    { name: "api", scope: "account", key: "account", max: 300, windowSeconds: 300 },
    { name: "media", scope: "account", key: "account", max: 30, windowSeconds: 1800, spentBy: "upload" },
    // DELETE /api/v1/statuses/:id: 30 within 30 minutes (docs.joinmastodon.org/api/rate-limits, read 2026-11-24).
    { name: "delete", scope: "account", key: "account", max: 30, windowSeconds: 1800, spentBy: "delete" },
  ],
  actionWindows: {},
  egressHostSource: "channel",
  // `default` leaves the visibility out of a create, so the account's own default applies.
  providerDefault: { visibility: "default", sensitive: false, spoiler_text: "" },
  followUpRoles: [],
  leaseSeconds: { prepare: 60, commit: 120, readBack: 60, delete: 60 },
  callTimeoutSeconds: 30,
  // VERIFY: the media page gives no upload time or processing limit; both are chosen here until a live run measures them.
  uploadTimeoutSeconds: 300,
  maxProcessingSeconds: 600,
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
  // The instance counts graphemes, a link counts `characters_reserved_per_url` whatever its length, and a remote
  // mention counts as `@name` (status_length_validator.rb in the Mastodon source).
  counting: { unit: "graphemes", urlWeight: 23, mentions: "local_part" },
  apiAccess: "official",
  apiVersions: [
    // VERIFY: `introduced` is the release date of 4.0.0, the first version with the v2 instance answer (GitHub releases).
    { version: "v2", introduced: "2022-11-18", docsUrl: INSTANCE_DOCS, checked: CHECKED },
  ],
  limits: {
    textLength: { value: 500, source: INSTANCE_DOCS, checked: CHECKED },
    urlWeight: { value: 23, source: INSTANCE_DOCS, checked: CHECKED },
    mediaMaxCount: { value: 4, source: INSTANCE_DOCS, checked: CHECKED },
    // The example answer on the instance page (read 2026-11-27); an instance states its own and that one wins.
    imageMaxBytes: { value: 16_777_216, source: INSTANCE_DOCS, checked: "2026-11-27" },
    videoMaxBytes: { value: 103_809_024, source: INSTANCE_DOCS, checked: "2026-11-27" },
  },
});
