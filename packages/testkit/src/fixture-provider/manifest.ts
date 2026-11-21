/**
 * The manifest of the `fixture` provider: the stand-in network the core publishing slices run against before any real
 * provider exists. It declares every capability the fault matrix has rows for. It is registered only in tests.
 */
export const fixtureManifest = {
  id: "fixture",
  displayName: "Fixture Network",
  lifecycle: "beta",
  auth: { method: "api_key" },
  scopes: ["post.write"],
  capabilities: ["text", "thread", "first_comment", "edit", "delete"],
  readBackMode: "A",
  idempotency: { mechanism: "header", keyWindowSeconds: 3600, resendAfterUnknown: "same_key_in_window" },
  retrySafety: {
    prepare: "safe",
    commit: "read_back_first",
    readBack: "safe",
    edit: "read_back_first",
    delete: "safe",
  },
  rateLimits: [{ name: "posts", scope: "account", key: "account_id", max: 300, windowSeconds: 10800 }],
  actionWindows: { edit: 3600 },
  egressHosts: ["api.fixture.example"],
  followUpRoles: ["thread_reply", "first_comment"],
  leaseSeconds: { prepare: 60, commit: 120, readBack: 60, edit: 120, delete: 60 },
  concurrency: 4,
  refreshErrorMap: {
    grant_revoked: "revoked",
    slow_down: "rate_limited",
    invalid_client: "config",
  },
  absentAnswers: [{ status: 404 }],
  counting: { unit: "graphemes", urlWeight: 23 },
  apiAccess: "official",
  apiVersions: [
    {
      version: "v1",
      introduced: "2026-01-01",
      docsUrl: "https://docs.fixture.example/api/v1",
      checked: "2026-11-21",
    },
  ],
  limits: {
    textLength: { value: 500, source: "https://docs.fixture.example/limits", checked: "2026-11-21" },
  },
} as const;
