import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// Docs only until a live run records the answers: every number is what the cited page says and none was measured.
const WEBHOOK_DOCS = "https://docs.discord.com/developers/resources/webhook";
const CHECKED = "2026-11-27";

export const discordManifest = manifestSchema.parse({
  id: "discord",
  displayName: "Discord",
  lifecycle: "beta",
  auth: { method: "webhook_url" },
  scopes: [],
  capabilities: ["text", "image", "edit", "delete"],
  // A send has no id to look for after a lost answer, so an unknown outcome is never sent again.
  readBackMode: "E",
  idempotency: { mechanism: "none", keyWindowSeconds: 0, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "never", readBack: "safe", edit: "safe", delete: "safe" },
  rateLimits: [{ name: "webhook", scope: "webhook", key: "webhook", max: 5, windowSeconds: 2 }],
  actionWindows: {},
  // Other hosts join after a live check (the first two are the ones the docs name).
  egressHosts: ["discord.com", "discordapp.com"],
  followUpRoles: [],
  leaseSeconds: { prepare: 30, commit: 60, readBack: 30, edit: 60, delete: 60 },
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
  refreshErrorMap: {},
  absentAnswers: [],
  // VERIFY: the strictest rule `countText` offers, until the docs state how Discord counts.
  counting: { unit: "graphemes" },
  apiAccess: "official",
  apiVersions: [],
  limits: {
    textLength: { value: 2000, source: `${WEBHOOK_DOCS}#execute-webhook`, checked: CHECKED },
    mediaMaxCount: { value: 10, source: `${WEBHOOK_DOCS}#execute-webhook`, checked: CHECKED },
    imageMaxBytes: { value: 20_971_520, source: `${WEBHOOK_DOCS}#execute-webhook`, checked: CHECKED },
  },
});
