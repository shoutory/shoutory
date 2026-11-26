import { type Draft, settingsIssues, supportsVariant } from "@shoutory/core/content";
import { buildSnapshot, type Resolved, snapshotHash } from "@shoutory/core/content/snapshot";
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
