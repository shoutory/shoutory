import { countingRuleSchema } from "@shoutory/core/counting";
import { z } from "zod";

const date = z.iso.date();
const httpsUrl = z.url({ protocol: /^https$/ });
const seconds = z.int().positive().max(31_536_000);
const name = z.string().min(1).max(64);

// A provider limit is a fact about the provider, so it names where it was read and when (never a bare number).
const limitSchema = z.strictObject({
  value: z.int().positive(),
  source: httpsUrl,
  checked: date,
});

const retrySafetySchema = z.enum(["safe", "read_back_first", "never"]);

const apiVersionSchema = z.strictObject({
  version: name,
  introduced: date,
  sunset: date.optional(),
  docsUrl: httpsUrl,
  probeUrl: httpsUrl.optional(),
  checked: date,
});

const CAPABILITIES = [
  "text",
  "image",
  "video",
  "link_card",
  "thread",
  "first_comment",
  "edit",
  "delete",
] as const;

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// A host name of at least two lowercase RFC 1123 labels whose top label is not all digits (an IP literal is not a name),
// with a wildcard only as `*.` in front of at least two labels (never a whole suffix such as `*.com`).
function isEgressHost(value: string): boolean {
  const labels = (value.startsWith("*.") ? value.slice(2) : value).split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? "")
  );
}

const manifestShape = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  // Shown in the generated capability table, so no table separator or line break.
  displayName: name.regex(/^[^|\r\n]+$/),
  lifecycle: z.enum(["beta", "ga"]),
  auth: z.strictObject({
    method: z.enum(["oauth2", "oauth2_pkce", "api_key", "bot_token", "app_password", "webhook_url"]),
  }),
  scopes: z.array(name).max(64),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  readBackMode: z.enum(["A", "B", "C", "D", "E"]),
  idempotency: z.strictObject({
    mechanism: z.enum(["header", "nonce", "natural_key", "none"]),
    keyWindowSeconds: z.int().nonnegative().max(31_536_000),
    resendAfterUnknown: z.enum(["same_key_in_window", "read_back_only"]),
  }),
  retrySafety: z.strictObject({
    prepare: retrySafetySchema,
    commit: retrySafetySchema,
    readBack: retrySafetySchema,
    edit: retrySafetySchema.optional(),
    delete: retrySafetySchema.optional(),
  }),
  rateLimits: z
    .array(
      z.strictObject({
        name,
        scope: z.enum(["account", "chat", "webhook", "instance", "app"]),
        key: name,
        max: z.int().positive(),
        windowSeconds: seconds,
      }),
    )
    .max(32),
  actionWindows: z.strictObject({ edit: seconds.optional(), delete: seconds.optional() }),
  egressHosts: z.array(z.string().max(253).refine(isEgressHost, "not a host name")).min(1).max(32),
  sunset: date.optional(),
  providerDefault: z.record(name, z.union([z.string().max(256), z.number(), z.boolean()])).optional(),
  followUpRoles: z.array(z.enum(["thread_reply", "first_comment"])).max(2),
  leaseSeconds: z.strictObject({
    prepare: seconds,
    commit: seconds,
    readBack: seconds,
    edit: seconds.optional(),
    delete: seconds.optional(),
  }),
  concurrency: z.int().positive().max(1000),
  refreshErrorMap: z.record(name, z.enum(["revoked", "transient"])),
  absentAnswers: z.array(z.strictObject({ status: z.int().min(400).max(599) })).max(8),
  counting: countingRuleSchema,
  // Only an official API is ever used; any other value refuses the manifest.
  apiAccess: z.literal("official"),
  apiVersions: z.array(apiVersionSchema).max(16),
  limits: z.record(name, limitSchema),
});

type ManifestShape = z.infer<typeof manifestShape>;
interface CrossFieldIssue {
  readonly path: string[];
  readonly message: string;
}

// A declared edit or delete needs its retry rule and its lease.
function declaredActionIssues(manifest: ManifestShape): CrossFieldIssue[] {
  return (["edit", "delete"] as const).flatMap((action) => {
    if (!manifest.capabilities.includes(action)) return [];
    const issues: CrossFieldIssue[] = [];
    if (manifest.retrySafety[action] === undefined) {
      issues.push({
        path: ["retrySafety", action],
        message: `retrySafety needs the ${action} action that capabilities list`,
      });
    }
    if (manifest.leaseSeconds[action] === undefined) {
      issues.push({
        path: ["leaseSeconds", action],
        message: `leaseSeconds needs the ${action} action that capabilities list`,
      });
    }
    return issues;
  });
}

// The resend rules must not contradict the idempotency the provider offers or the read-back it allows.
function resendIssues({ idempotency, readBackMode, retrySafety }: ManifestShape): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const sameKey = idempotency.resendAfterUnknown === "same_key_in_window";
  if (sameKey && idempotency.mechanism === "none") {
    issues.push({
      path: ["idempotency", "resendAfterUnknown"],
      message: "a resend with the same key needs an idempotency mechanism",
    });
  }
  if (sameKey && idempotency.keyWindowSeconds === 0) {
    issues.push({
      path: ["idempotency", "keyWindowSeconds"],
      message: "a resend with the same key needs a key window above zero",
    });
  }
  if (readBackMode === "E" && sameKey) {
    issues.push({
      path: ["idempotency", "resendAfterUnknown"],
      message: "a provider with no read-back must not resend after an unknown outcome",
    });
  }
  if (retrySafety.commit === "safe" && (idempotency.mechanism === "none" || readBackMode === "E")) {
    issues.push({
      path: ["retrySafety", "commit"],
      message: "a commit can be safe to retry only with an idempotency mechanism and a read-back",
    });
  }
  return issues;
}

export const manifestSchema = manifestShape.superRefine((manifest, context) => {
  for (const issue of [...declaredActionIssues(manifest), ...resendIssues(manifest)]) {
    context.addIssue({ code: "custom", ...issue });
  }
});

export type Manifest = z.infer<typeof manifestSchema>;
