import { manifestSchema } from "@shoutory/provider-sdk/manifest";

// Docs only until a live run records the answers: every number is what the cited page says and none was measured.
const BOT_API = "https://core.telegram.org/bots/api";
const CHECKED = "2026-11-27";

export const telegramManifest = manifestSchema.parse({
  id: "telegram",
  displayName: "Telegram",
  lifecycle: "beta",
  auth: { method: "bot_token" },
  scopes: [],
  capabilities: ["text", "image", "edit", "delete"],
  // A send has no id to look for after a lost answer, so an unknown outcome is never sent again.
  readBackMode: "E",
  idempotency: { mechanism: "none", keyWindowSeconds: 0, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "never", readBack: "safe", edit: "safe", delete: "safe" },
  // One message a second to a chat and 30 a second overall (core.telegram.org/bots/faq, read 2026-11-27).
  rateLimits: [{ name: "chat", scope: "chat", key: "chat", max: 20, windowSeconds: 60 }],
  // `deleteMessage` removes a message within 48 hours (core.telegram.org/bots/api#deletemessage, read 2026-11-27).
  actionWindows: { delete: 172_800 },
  egressHosts: ["api.telegram.org"],
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
  // VERIFY: Telegram counts the characters of the text after its entities are parsed.
  counting: { unit: "utf16" },
  apiAccess: "official",
  apiVersions: [],
  limits: {
    textLength: { value: 4096, source: `${BOT_API}#sendmessage`, checked: CHECKED },
    mediaMaxCount: { value: 10, source: `${BOT_API}#sendmediagroup`, checked: CHECKED },
    imageMaxBytes: { value: 10_485_760, source: `${BOT_API}#sendphoto`, checked: CHECKED },
  },
});
