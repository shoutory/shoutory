import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// Docs only until a live run records the answers: every number is what the cited page says and none was measured.
const WEBHOOK_DOCS = "https://docs.discord.com/developers/resources/webhook";
const MESSAGE_DOCS = "https://docs.discord.com/developers/resources/message";
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
  // VERIFY: no page read gives a number; the docs say to read the headers. This is a conservative guess for one webhook.
  rateLimits: [{ name: "webhook", scope: "webhook", key: "webhook", max: 5, windowSeconds: 2 }],
  actionWindows: {},
  // Other hosts join after a live check (the first two are the ones the docs name).
  egressHosts: ["discord.com", "discordapp.com"],
  followUpRoles: [],
  // VERIFY: the files travel in the commit request, so a 25 MiB commit is bounded by `callTimeoutSeconds` and its lease
  // (the ledger applies the upload timeout to the prepare step only); 120 seconds allows about 0.2 MiB per second.
  leaseSeconds: { prepare: 30, commit: 180, readBack: 30, edit: 60, delete: 60 },
  callTimeoutSeconds: 120,
  uploadTimeoutSeconds: 120,
  retryAfterMaxSeconds: 900,
  dispatchMarginSeconds: 300,
  maxInFlightSeconds: 180,
  readBackGapSeconds: 30,
  maxAttempts: 5,
  unverifiedHorizonDays: 30,
  clockSkewSeconds: 120,
  concurrency: 4,
  refreshErrorMap: {},
  absentAnswers: [],
  // VERIFY: the docs say "characters" without a rule; UTF-16 units are the strictest `countText` offers that counts every
  // character, until a live check shows how Discord counts.
  counting: { unit: "utf16" },
  apiAccess: "official",
  apiVersions: [],
  limits: {
    textLength: { value: 2000, source: `${WEBHOOK_DOCS}#execute-webhook`, checked: CHECKED },
    // Declared for the composer; this provider publishes no embeds yet.
    embedMaxCount: { value: 10, source: `${WEBHOOK_DOCS}#execute-webhook`, checked: CHECKED },
    embedTextMax: { value: 6000, source: MESSAGE_DOCS, checked: CHECKED },
    imageMaxBytes: {
      value: 20_971_520,
      source: "https://docs.discord.com/developers/reference",
      checked: CHECKED,
    },
    // VERIFY: stated for create-message; an execute-webhook request is assumed to share it until a live check.
    requestMaxBytes: { value: 26_214_400, source: MESSAGE_DOCS, checked: CHECKED },
  },
});
