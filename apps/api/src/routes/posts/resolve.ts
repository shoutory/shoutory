import { type Draft, settingsIssues } from "@shoutory/core/content";
import { buildSnapshot, type Resolved, snapshotHash } from "@shoutory/core/content/snapshot";
import { mediaFits, type RejectReason, VIDEO_TYPES } from "@shoutory/core/media";
import type { TenantTx } from "@shoutory/db/context";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";

// What a draft needs from the server before it can be stored: the channels it names (they must exist in the workspace and
// have a provider the app holds), the media it uses (ready, and inside the rules of its channel) and the settings each channel
// accepts. One function turns a draft into the snapshot a version keeps and its hash, inside the transaction of the write.

type Providers = Readonly<Record<string, HealthProvider>>;
type Defaults = Readonly<Record<string, string | number | boolean>>;

const MAX_ISSUES = 20;

const unprocessable = (reason: string, rule?: RejectReason): Refusal =>
  new Refusal("unprocessable_content", `draft refused: ${reason}`, {
    details: { reason, ...(rule ? { rule } : {}) },
  });

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
    // Own keys only: a provider id read from a row is never looked up on the prototype.
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (!provider) {
      throw new Refusal("conflict", "no adapter for the provider", {
        details: { reason: "provider_unavailable" },
      });
    }
    byChannel.set(id, provider);
  }
  return byChannel;
}

interface ReadyMedium {
  id: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  /** The size of the `stripped` copy of an image, or of the original of a video: the bytes a provider receives. */
  bytes: number;
  /** The length of a video in milliseconds; null for an image. */
  durationMs: number | null;
}

/**
 * The media a draft names, each one `ready` in this workspace with its `stripped` copy (an image) or as an original that
 * is sent as it is (a video, which has no derivative); any other is unavailable.
 */
async function readyMedia(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
): Promise<Map<string, ReadyMedium>> {
  const ids = [...new Set(draft.variants.flatMap((v) => v.media.map((m) => m.media_id.toLowerCase())))];
  if (ids.length === 0) return new Map();
  const found = await tx.query<ReadyMedium>(
    `SELECT a.id, encode(a.sha256, 'hex') AS sha256, a.mime, a.width, a.height,
       coalesce(d.byte_size, a.byte_size)::float8 AS bytes, a.duration_ms AS "durationMs"
     FROM app.media_assets AS a
     LEFT JOIN app.media_derivatives AS d ON d.workspace_id = a.workspace_id AND d.media_id = a.id
       AND d.profile = 'stripped' AND d.state = 'ready'
     WHERE a.workspace_id = $1 AND a.id = ANY ($2::uuid[]) AND a.state = 'ready'
       AND (d.media_id IS NOT NULL OR a.mime = ANY ($3::text[]))`,
    [workspaceId, ids, [...VIDEO_TYPES]],
  );
  if (found.rows.length !== ids.length) throw unprocessable("media_unavailable");
  return new Map(found.rows.map((row) => [row.id, row]));
}

/** The one rule set of core, with the manifest of each variant's channel: a medium it refuses is refused here, not at publish. */
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

/** The settings of the draft against what each channel's provider declares; a refusal names the caller's own keys. */
function checkSettings(draft: Draft, defaults: Record<string, Defaults>): void {
  const issues = settingsIssues(draft, defaults);
  const first = issues[0];
  if (!first) return;
  const reason = first.reason === "undeclared" ? "settings_undeclared" : "settings_type";
  // The answer lists at most MAX_ISSUES, and says so when it cut the list.
  const cut = issues.length > MAX_ISSUES;
  throw new Refusal("unprocessable_content", "draft refused: settings", {
    details: { reason, issues: issues.slice(0, MAX_ISSUES), ...(cut ? { truncated: true } : {}) },
  });
}

/** The snapshot of a draft and its hash, or the refusal that says which part of the draft the server cannot take. */
export async function resolveDraft(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
  providers: Providers,
  now: Date,
) {
  const channels = await providersOfChannels(tx, workspaceId, draft, providers);
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
