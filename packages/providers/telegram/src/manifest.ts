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
  // About one message a second to a chat and 20 a minute to a group (core.telegram.org/bots/faq, read 2026-11-27). The
  // 30 a second a bot may send overall has no bucket key here, so a 429 pauses instead.
  rateLimits: [
    { name: "chat_second", scope: "chat", key: "chat", max: 1, windowSeconds: 1 },
    { name: "chat_minute", scope: "chat", key: "chat", max: 20, windowSeconds: 60 },
  ],
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
  // VERIFY: the page says "characters after entities parsing" and measures entities in UTF-16 code units
  // (core.telegram.org/bots/api#sendmessage, read 2026-11-27) but never names the unit; UTF-16 is the strictest reading.
  counting: { unit: "utf16" },
  apiAccess: "official",
  apiVersions: [],
  limits: {
    textLength: { value: 4096, source: `${BOT_API}#sendmessage`, checked: CHECKED },
    captionLength: { value: 1024, source: `${BOT_API}#sendphoto`, checked: CHECKED },
    mediaMaxCount: { value: 10, source: `${BOT_API}#sendmediagroup`, checked: CHECKED },
    // "10 MB max size for photos" by multipart upload, 5 MB by URL; only photos are sent here
    // (core.telegram.org/bots/api#sending-files, read 2026-11-27). VERIFY: the page does not say whether an MB is
    // 10^6 or 2^20 bytes, so the smaller is used.
    imageMaxBytes: { value: 10_000_000, source: `${BOT_API}#sending-files`, checked: CHECKED },
  },
});
