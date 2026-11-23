// A complete manifest for the provider named `fixture`, the only provider name the SDK tests use. Each test copies it
// and changes the one field under test.
export function fixtureManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fixture",
    displayName: "Fixture Network",
    lifecycle: "beta",
    auth: { method: "oauth2_pkce" },
    scopes: ["post.write"],
    capabilities: ["text", "edit", "delete"],
    readBackMode: "A",
    idempotency: { mechanism: "header", keyWindowSeconds: 3600, resendAfterUnknown: "same_key_in_window" },
    retrySafety: {
      prepare: "safe",
      commit: "read_back_first",
      readBack: "safe",
      edit: "read_back_first",
      delete: "safe",
    },
    rateLimits: [{ name: "posts", scope: "account", key: "account", max: 300, windowSeconds: 10800 }],
    actionWindows: { edit: 3600 },
    egressHosts: ["api.fixture.example"],
    providerDefault: { visibility: "public" },
    followUpRoles: ["thread_reply"],
    leaseSeconds: { prepare: 60, commit: 120, readBack: 60, edit: 120, delete: 60 },
    callTimeoutSeconds: 30,
    retryAfterMaxSeconds: 900,
    dispatchMarginSeconds: 300,
    maxInFlightSeconds: 60,
    readBackGapSeconds: 30,
    maxAttempts: 5,
    unverifiedHorizonDays: 30,
    clockSkewSeconds: 120,
    concurrency: 4,
    refreshErrorMap: { invalid_grant: "revoked", temporarily_unavailable: "transient" },
    absentAnswers: [{ status: 404 }],
    counting: { unit: "graphemes", urlWeight: 23 },
    apiAccess: "official",
    apiVersions: [
      {
        version: "v1",
        introduced: "2026-01-01",
        sunset: "2030-01-01",
        docsUrl: "https://docs.fixture.example/api/v1",
        checked: "2026-11-21",
      },
    ],
    limits: {
      textLength: {
        value: 500,
        source: "https://docs.fixture.example/limits",
        checked: "2026-11-21",
      },
    },
    ...overrides,
  };
}
