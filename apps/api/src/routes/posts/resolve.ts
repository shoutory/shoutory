import {
  type Draft,
  draftSchema,
  settingsIssues,
  supportsVariant,
  targetOf,
  type Variant,
} from "@shoutory/core/content";
import { buildSnapshot, type Resolved, snapshotHash } from "@shoutory/core/content/snapshot";
import { countText } from "@shoutory/core/counting";
import { mediaFits, type RejectReason } from "@shoutory/core/media";
import type { TenantTx } from "@shoutory/db/context";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";

export type Providers = Readonly<Record<string, HealthProvider>>;
type Defaults = Readonly<Record<string, string | number | boolean>>;

const MAX_ISSUES = 20;

const unprocessable = (reason: string, rule?: RejectReason): Refusal =>
  new Refusal("unprocessable_content", `draft refused: ${reason}`, {
    details: { reason, ...(rule ? { rule } : {}) },
  });

// Own keys only: a provider id read from a row is never looked up on the prototype.
const providerOf = (providers: Providers, providerId: string): HealthProvider | undefined =>
  Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;

async function providersOfChannels(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
  providers: Providers,
): Promise<Map<string, HealthProvider>> {
  const ids = [...new Set(draft.variants.map((variant) => variant.channel_id.toLowerCase()))];
  const found = await tx.query<{ id: string; provider_id: string }>(
    "SELECT id, provider_id FROM app.channels WHERE workspace_id = $1 AND id = ANY ($2::uuid[])",
    [workspaceId, ids],
  );
  if (found.rows.length !== ids.length) throw unprocessable("unknown_channel");
  const byChannel = new Map<string, HealthProvider>();
  for (const { id, provider_id: providerId } of found.rows) {
    const provider = providerOf(providers, providerId);
    if (!provider) {
      throw new Refusal("conflict", "no adapter for the provider", {
        details: { reason: "provider_unavailable" },
      });
    }
    byChannel.set(id, provider);
  }
  return byChannel;
}

export interface ReadyMedium {
  id: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  /** The size of the `stripped` copy, the one a provider receives. */
  bytes: number;
  durationMs: number | null;
}

/** The ready media among `ids`, each with the facts of the copy a provider receives. */
export async function readyMediaOf(
  tx: TenantTx,
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, ReadyMedium>> {
  const found = await tx.query<ReadyMedium>(
    `SELECT a.id, encode(a.sha256, 'hex') AS sha256, a.mime, a.width, a.height,
       d.byte_size::float8 AS bytes, a.duration_ms AS "durationMs"
     FROM app.media_assets AS a
     JOIN app.media_derivatives AS d ON d.workspace_id = a.workspace_id AND d.media_id = a.id
       AND d.profile = 'stripped' AND d.state = 'ready'
     WHERE a.workspace_id = $1 AND a.id = ANY ($2::uuid[]) AND a.state = 'ready'`,
    [workspaceId, ids],
  );
  return new Map(found.rows.map((row) => [row.id, row]));
}

async function readyMedia(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
): Promise<Map<string, ReadyMedium>> {
  const ids = [...new Set(draft.variants.flatMap((v) => v.media.map((m) => m.media_id.toLowerCase())))];
  if (ids.length === 0) return new Map();
  const found = await readyMediaOf(tx, workspaceId, ids);
  if (found.size !== ids.length) throw unprocessable("media_unavailable");
  return found;
}

export type ChannelFit = { ok: true } | { ok: false; reason: string };

/** Whether one medium can go to a channel of this provider, refused for the reason a save would give. */
export function channelFit(medium: ReadyMedium, providers: Providers, providerId: string): ChannelFit {
  const provider = providerOf(providers, providerId);
  if (!provider) return { ok: false, reason: "provider_unavailable" };
  if (provider.manifest.capabilities.length === 0) return { ok: false, reason: "capability_missing" };
  const fit = mediaFits({ ...medium, count: 1 }, provider.manifest);
  return fit.ok ? { ok: true } : { ok: false, reason: fit.reason };
}

// A medium the channel's rules refuse is refused here, not at publish.
function checkMediaRules(
  draft: Draft,
  media: Map<string, ReadyMedium>,
  channels: Map<string, HealthProvider>,
) {
  for (const variant of draft.variants) {
    const rules = channels.get(variant.channel_id.toLowerCase())?.manifest;
    for (const { media_id: id } of variant.media) {
      const medium = media.get(id.toLowerCase());
      if (!medium || !rules) continue;
      const fit = mediaFits({ ...medium, count: variant.media.length }, rules);
      if (!fit.ok) throw unprocessable("media_unavailable", fit.reason);
    }
  }
}

function checkSettings(draft: Draft, defaults: Record<string, Defaults>): void {
  const issues = settingsIssues(draft, defaults);
  const first = issues[0];
  if (!first) return;
  const reason = first.reason === "undeclared" ? "settings_undeclared" : "settings_type";
  const cut = issues.length > MAX_ISSUES;
  throw new Refusal("unprocessable_content", "draft refused: settings", {
    details: { reason, issues: issues.slice(0, MAX_ISSUES), ...(cut ? { truncated: true } : {}) },
  });
}

interface VariantIssue {
  variant: number;
  key: string;
  reason: string;
}

// What a provider refuses of one variant: the text it cannot hold, a post type it does not take, nothing to send and
// more media than it allows. A draft may hold all of these; scheduling may not.
function variantIssues(
  variant: Variant,
  index: number,
  manifest: HealthProvider["manifest"],
): VariantIssue[] {
  const issues: VariantIssue[] = [];
  const limit = manifest.limits.textLength?.value;
  const long = (text: string) => limit !== undefined && countText(manifest.counting, text) > limit;
  if (!supportsVariant(variant, manifest))
    issues.push({ variant: index, key: "post_type", reason: "unsupported" });
  if (long(variant.text)) issues.push({ variant: index, key: "text", reason: "too_long" });
  variant.parts.forEach((part, at) => {
    if (long(part.text)) issues.push({ variant: index, key: `parts.${at}`, reason: "too_long" });
  });
  if (variant.text.trim() === "" && variant.media.length === 0) {
    issues.push({ variant: index, key: "text", reason: "empty" });
  }
  const most = manifest.limits.mediaMaxCount?.value;
  if (most !== undefined && variant.media.length > most) {
    issues.push({ variant: index, key: "media", reason: "too_many" });
  }
  return issues;
}

// A medium still in the pipeline is accepted: admission holds the target until it is ready. One that is rejected,
// deleted or not there is refused now.
const WAITABLE = ["uploaded", "scanning", "processing", "ready"];
async function requireUsableMedia(tx: TenantTx, workspaceId: string, draft: Draft): Promise<void> {
  const ids = [...new Set(draft.variants.flatMap((v) => v.media.map((m) => m.media_id.toLowerCase())))];
  if (ids.length === 0) return;
  const found = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.media_assets WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND state = ANY ($3::text[])",
    [workspaceId, ids, WAITABLE],
  );
  if (found.rows[0]?.n !== ids.length) throw unprocessable("media_unavailable");
}

/**
 * The strict form of the manifest's limits, then the media, for a draft about to be scheduled or to replace a
 * published one.
 */
export async function checkVariants(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
  providers: Providers,
): Promise<void> {
  const channels = await providersOfChannels(tx, workspaceId, draft, providers);
  const issues = draft.variants.flatMap((variant, index) => {
    const manifest = channels.get(variant.channel_id.toLowerCase())?.manifest;
    return manifest ? variantIssues(variant, index, manifest) : [];
  });
  if (issues.length > 0) {
    throw new Refusal("unprocessable_content", "draft refused: variant", {
      details: {
        reason: "variant_invalid",
        issues: issues.slice(0, MAX_ISSUES),
        ...(issues.length > MAX_ISSUES ? { truncated: true } : {}),
      },
    });
  }
  await requireUsableMedia(tx, workspaceId, draft);
}

/**
 * The checks that only scheduling makes, for the targets it names (all of the post's when none are named). The draft
 * is the one the post is at now; its version id is returned so the write can refuse if the post has moved on.
 */
export async function checkForSchedule(
  tx: TenantTx,
  workspaceId: string,
  postId: string,
  variantIds: readonly string[] | undefined,
  providers: Providers,
): Promise<string> {
  const found = await tx.query<{ version_id: string; draft: unknown }>(
    `SELECT v.id AS version_id, v.snapshot -> 'draft' AS draft FROM app.posts AS p
       JOIN app.post_versions AS v ON v.workspace_id = p.workspace_id AND v.id = p.current_version_id
      WHERE p.workspace_id = $1 AND p.id = $2`,
    [workspaceId, postId],
  );
  const parsed = draftSchema.safeParse(found.rows[0]?.draft);
  if (!parsed.success || found.rows[0] === undefined) throw unprocessable("draft_invalid");
  const named = await tx.query<{ channel_id: string; locale: string | null }>(
    `SELECT channel_id, locale FROM app.post_variants
      WHERE workspace_id = $1 AND post_id = $2 AND ($3::uuid[] IS NULL OR id = ANY ($3::uuid[]))`,
    [workspaceId, postId, variantIds ?? null],
  );
  const wanted = new Set(named.rows.map(targetOf));
  const draft: Draft = { variants: parsed.data.variants.filter((variant) => wanted.has(targetOf(variant))) };
  await checkVariants(tx, workspaceId, draft, providers);
  return found.rows[0].version_id;
}

export async function resolveDraft(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
  providers: Providers,
  now: Date,
) {
  const channels = await providersOfChannels(tx, workspaceId, draft, providers);
  // A provider that declares no capability at all (its publishing has not shipped) can take no post.
  if ([...channels.values()].some((provider) => provider.manifest.capabilities.length === 0)) {
    throw unprocessable("capability_missing");
  }
  for (const variant of draft.variants) {
    const provider = channels.get(variant.channel_id.toLowerCase());
    if (!provider || !supportsVariant(variant, provider.manifest))
      throw unprocessable("post_type_unsupported");
  }
  const ready = await readyMedia(tx, workspaceId, draft);
  checkMediaRules(draft, ready, channels);
  const media = Object.fromEntries([...ready.values()].map((medium) => [medium.id, medium.sha256]));
  const defaults = Object.fromEntries(
    [...channels].map(([id, provider]) => [id, provider.manifest.providerDefault ?? {}]),
  );
  checkSettings(draft, defaults);
  const resolved: Resolved = {
    variants: draft.variants.map((variant) => ({
      channel_id: variant.channel_id.toLowerCase(),
      locale: variant.locale,
      settings: { ...defaults[variant.channel_id.toLowerCase()], ...variant.settings },
    })),
    media,
    manifestDigest: Object.fromEntries(
      [...channels].map(([id, provider]) => [id, snapshotOf(provider.manifest, now).manifestDigest]),
    ),
  };
  const built = buildSnapshot(draft, resolved);
  if (!built.ok) throw unprocessable(built.code);
  return { snapshot: built.snapshot, hash: snapshotHash(built.snapshot) };
}
