import { describe, expect, it } from "vitest";
import { fixtureManifest } from "../../test/fixture-manifest.js";
import { manifestSchema } from "./manifest.js";

type Mutate = (manifest: Record<string, unknown>) => void;
const at = (manifest: Record<string, unknown>, key: string) => manifest[key] as Record<string, unknown>;
const first = (manifest: Record<string, unknown>, key: string) =>
  (manifest[key] as Record<string, unknown>[])[0] as Record<string, unknown>;

// Each row: what is wrong, how the complete manifest is damaged, and the path of the issue that must name it.
const REFUSALS: [string, Mutate, string][] = [
  [
    "a limit without a source",
    (m) => delete at(at(m, "limits"), "textLength").source,
    "limits.textLength.source",
  ],
  [
    "a limit without a checked date",
    (m) => delete at(at(m, "limits"), "textLength").checked,
    "limits.textLength.checked",
  ],
  ["retrySafety missing the commit action", (m) => delete at(m, "retrySafety").commit, "retrySafety.commit"],
  [
    "retrySafety missing the edit action that capabilities list",
    (m) => delete at(m, "retrySafety").edit,
    "retrySafety.edit",
  ],
  [
    "retrySafety missing the delete action that capabilities list",
    (m) => delete at(m, "retrySafety").delete,
    "retrySafety.delete",
  ],
  ["a rateLimits entry without scope", (m) => delete first(m, "rateLimits").scope, "rateLimits.0.scope"],
  ["a rateLimits entry without key", (m) => delete first(m, "rateLimits").key, "rateLimits.0.key"],
  [
    "a rateLimits scope outside account, chat, webhook, instance, app",
    (m) => {
      first(m, "rateLimits").scope = "region";
    },
    "rateLimits.0.scope",
  ],
  [
    "a rateLimits key outside the channel columns the worker can read",
    (m) => {
      first(m, "rateLimits").key = "region";
    },
    "rateLimits.0.key",
  ],
  [
    "a rateLimits max above what the bucket accepts",
    (m) => {
      first(m, "rateLimits").max = 10_001;
    },
    "rateLimits.0.max",
  ],
  [
    "a rateLimits window above a day",
    (m) => {
      first(m, "rateLimits").windowSeconds = 86_401;
    },
    "rateLimits.0.windowSeconds",
  ],
  [
    "a lease above an hour",
    (m) => {
      at(m, "leaseSeconds").commit = 3_601;
    },
    "leaseSeconds.commit",
  ],
  ["a missing call timeout", (m) => delete m.callTimeoutSeconds, "callTimeoutSeconds"],
  [
    "a call timeout above an hour",
    (m) => {
      m.callTimeoutSeconds = 3_601;
    },
    "callTimeoutSeconds",
  ],
  ["a missing retry-after maximum", (m) => delete m.retryAfterMaxSeconds, "retryAfterMaxSeconds"],
  [
    "a retry-after maximum above a day",
    (m) => {
      m.retryAfterMaxSeconds = 86_401;
    },
    "retryAfterMaxSeconds",
  ],
  ["a missing dispatch margin", (m) => delete m.dispatchMarginSeconds, "dispatchMarginSeconds"],
  [
    "a dispatch margin above an hour",
    (m) => {
      m.dispatchMarginSeconds = 3_601;
    },
    "dispatchMarginSeconds",
  ],
  [
    "apiAccess other than official",
    (m) => {
      m.apiAccess = "scraping";
    },
    "apiAccess",
  ],
  [
    "a lifecycle outside beta and ga",
    (m) => {
      m.lifecycle = "deprecated";
    },
    "lifecycle",
  ],
  [
    "resendAfterUnknown outside the two values",
    (m) => {
      at(m, "idempotency").resendAfterUnknown = "always";
    },
    "idempotency.resendAfterUnknown",
  ],
  [
    "a negative keyWindowSeconds",
    (m) => {
      at(m, "idempotency").keyWindowSeconds = -1;
    },
    "idempotency.keyWindowSeconds",
  ],
  [
    "an id that is not a lowercase word",
    (m) => {
      m.id = "Bad.Id";
    },
    "id",
  ],
  [
    "a capability outside the closed vocabulary",
    (m) => {
      m.capabilities = ["text", "teleport"];
    },
    "capabilities.1",
  ],
  [
    "an apiVersions sunset that is not a date",
    (m) => {
      first(m, "apiVersions").sunset = "next spring";
    },
    "apiVersions.0.sunset",
  ],
  [
    "an unknown top-level field",
    (m) => {
      m.brandId = "brand-1";
    },
    "",
  ],
  [
    "a resend in the key window with no idempotency mechanism",
    (m) => {
      at(m, "idempotency").mechanism = "none";
    },
    "idempotency.resendAfterUnknown",
  ],
  [
    "a resend in the key window with a zero key window",
    (m) => {
      at(m, "idempotency").keyWindowSeconds = 0;
    },
    "idempotency.keyWindowSeconds",
  ],
  [
    "no read-back that resends in the key window",
    (m) => {
      m.readBackMode = "E";
    },
    "idempotency.resendAfterUnknown",
  ],
  [
    "no read-back with a commit that is safe to retry",
    (m) => {
      m.readBackMode = "E";
      at(m, "idempotency").resendAfterUnknown = "read_back_only";
      at(m, "retrySafety").commit = "safe";
    },
    "retrySafety.commit",
  ],
  [
    "a commit safe to retry with no idempotency mechanism",
    (m) => {
      at(m, "idempotency").mechanism = "none";
      at(m, "idempotency").resendAfterUnknown = "read_back_only";
      at(m, "retrySafety").commit = "safe";
    },
    "retrySafety.commit",
  ],
  ...["*.com", "a..b", "localhost", "169.254.169.254", "10.0.0.1", "Api.Example.com"].map(
    (host): [string, Mutate, string] => [
      `the egress host ${host}`,
      (m) => {
        m.egressHosts = [host];
      },
      "egressHosts.0",
    ],
  ),
  ...["Fixture|Network", "Fixture\nNetwork", "Fixture\rNetwork"].map(
    (displayName): [string, Mutate, string] => [
      `a display name with ${JSON.stringify(displayName)}`,
      (m) => {
        m.displayName = displayName;
      },
      "displayName",
    ],
  ),
  // A default is merged into the settings a post stores, and those hold whole numbers only.
  ...[1.5, 2 ** 53].map((value): [string, Mutate, string] => [
    `a setting default of ${value}`,
    (m) => {
      m.providerDefault = { max_length: value };
    },
    "providerDefault.max_length",
  ]),
  ["an edit capability without an edit lease", (m) => delete at(m, "leaseSeconds").edit, "leaseSeconds.edit"],
  [
    "a delete capability without a delete lease",
    (m) => delete at(m, "leaseSeconds").delete,
    "leaseSeconds.delete",
  ],
  [
    "a capability listed twice",
    (m) => {
      m.capabilities = ["text", "edit", "delete", "text"];
    },
    "capabilities",
  ],
  [
    "a refresh capability with no refresh error classes",
    (m) => {
      m.capabilities = ["text", "refresh"];
      m.refreshErrorMap = {};
    },
    "refreshErrorMap",
  ],
  [
    "a thread capability with no thread_reply follow-up role",
    (m) => {
      m.capabilities = ["text", "thread"];
      m.followUpRoles = ["first_comment"];
    },
    "followUpRoles",
  ],
  [
    "a first_comment capability with no first_comment follow-up role",
    (m) => {
      m.capabilities = ["text", "first_comment"];
      m.followUpRoles = ["thread_reply"];
    },
    "followUpRoles",
  ],
  [
    "an image capability with no imageMaxBytes limit",
    (m) => {
      m.capabilities = ["text", "image"];
    },
    "limits.imageMaxBytes",
  ],
  [
    "a video capability with no videoMaxBytes limit",
    (m) => {
      m.capabilities = ["text", "video"];
    },
    "limits.videoMaxBytes",
  ],
  [
    "an upload limit with an unknown spender",
    (m) => {
      first(m, "rateLimits").spentBy = "always";
    },
    "rateLimits.0.spentBy",
  ],
  [
    "an upload timeout above an hour",
    (m) => {
      m.uploadTimeoutSeconds = 3_601;
    },
    "uploadTimeoutSeconds",
  ],
  [
    "a processing wait of zero",
    (m) => {
      m.maxProcessingSeconds = 0;
    },
    "maxProcessingSeconds",
  ],
  [
    "an api version that sunsets before it starts",
    (m) => {
      first(m, "apiVersions").sunset = "2025-12-31";
    },
    "apiVersions.0.sunset",
  ],
];

// The unknown-outcome and quota fields of the dispatch: each is required (a default would hide a provider that never
// said it) and bounded, so a manifest cannot make the worker wait for ever or retry without end.
const OUT_OF_BOUNDS: [string, unknown][] = [
  ["maxInFlightSeconds", 0],
  ["maxInFlightSeconds", 86_401],
  ["readBackGapSeconds", 0],
  ["maxAttempts", 0],
  ["maxAttempts", 21],
  ["unverifiedHorizonDays", 0],
  ["unverifiedHorizonDays", 3_651],
  ["clockSkewSeconds", 3_601],
];
for (const [field, value] of OUT_OF_BOUNDS) {
  REFUSALS.push([
    `${field} of ${String(value)}`,
    (m) => {
      m[field] = value;
    },
    field,
  ]);
}
for (const field of ["maxInFlightSeconds", "readBackGapSeconds", "maxAttempts", "unverifiedHorizonDays"]) {
  REFUSALS.push([`a missing ${field}`, (m) => delete m[field], field]);
}
REFUSALS.push(
  [
    "a quota above what the ledger counts",
    (m) => {
      m.quotas = [{ name: "posts", max: 10_001, windowSeconds: 3_600 }];
    },
    "quotas.0.max",
  ],
  [
    "a quota window above a day",
    (m) => {
      m.quotas = [{ name: "posts", max: 10, windowSeconds: 86_401 }];
    },
    "quotas.0.windowSeconds",
  ],
);

describe("manifestSchema", () => {
  it("accepts a complete manifest", () => {
    expect(manifestSchema.safeParse(fixtureManifest()).success).toBe(true);
  });

  it.each(REFUSALS)("refuses %s", (_title, damage, path) => {
    const manifest = fixtureManifest();
    damage(manifest);
    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
    expect(paths).toContain(path);
  });

  // A provider whose accounts live on user-chosen servers names no hosts: its host is the channel's stored instance, one
  // closed alternative to the list (never a wildcard), so exactly one of the two is declared.
  it.each(["channel", "open"])("accepts egressHostSource %s in place of the egressHosts list", (source) => {
    const manifest = fixtureManifest();
    delete manifest.egressHosts;
    manifest.egressHostSource = source;
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each([
    [
      "both the list and the channel source",
      (m: Record<string, unknown>) => (m.egressHostSource = "channel"),
    ],
    ["neither the list nor the channel source", (m: Record<string, unknown>) => delete m.egressHosts],
    [
      "a channel source other than channel",
      (m: Record<string, unknown>) => {
        delete m.egressHosts;
        m.egressHostSource = "any";
      },
    ],
  ])("refuses %s", (_title, damage) => {
    const manifest = fixtureManifest();
    damage(manifest);
    const result = manifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("egressHostSource");
  });

  // A provider whose publishing has not shipped declares no capability; post validation refuses a target on it.
  it("accepts an empty capability list", () => {
    const manifest = fixtureManifest();
    manifest.capabilities = [];
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("gives a manifest that declares no quota an empty list", () => {
    expect(manifestSchema.parse(fixtureManifest()).quotas).toEqual([]);
  });
});

describe("manifestSchema: limits", () => {
  it("holds a byte limit of text next to the counted one", () => {
    const manifest = fixtureManifest();
    manifest.limits = {
      ...(manifest.limits as object),
      textBytes: { value: 3000, source: "https://atproto.com/specs/lexicon", checked: "2026-11-27" },
    };
    expect(manifestSchema.parse(manifest).limits.textBytes?.value).toBe(3000);
  });
});

describe("manifestSchema: token refresh", () => {
  it.each(["transient", "rate_limited", "config", "revoked"])(
    "accepts the refresh error class %s",
    (klass) => {
      const manifest = fixtureManifest();
      manifest.refreshErrorMap = { some_code: klass };
      expect(manifestSchema.safeParse(manifest).success).toBe(true);
    },
  );

  it("refuses a refresh error class outside the four", () => {
    const manifest = fixtureManifest();
    manifest.refreshErrorMap = { some_code: "disconnect_now" };
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("accepts the refresh capability", () => {
    const manifest = fixtureManifest();
    manifest.capabilities = [...(manifest.capabilities as string[]), "refresh"];
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("manifestSchema: capabilities with what they need", () => {
  it("accepts image, thread, first_comment and refresh together with their role and limit", () => {
    const manifest = fixtureManifest({
      capabilities: ["text", "image", "thread", "first_comment", "refresh"],
      followUpRoles: ["thread_reply", "first_comment"],
    });
    (manifest.limits as Record<string, unknown>).imageMaxBytes = {
      value: 1_000_000,
      source: "https://docs.fixture.example/limits",
      checked: "2026-11-21",
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });
});
