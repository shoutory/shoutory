import { type Draft, settingsIssues } from "@shoutory/core/content";
import { buildSnapshot, type Resolved, snapshotHash } from "@shoutory/core/content/snapshot";
import type { TenantTx } from "@shoutory/db/context";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import type { HealthProvider } from "../../channels/health.js";
import { Refusal } from "../../errors/refusal.js";

// What a draft needs from the server before it can be stored: the channels it names (they must exist in the workspace and
// have a provider the app holds), the media it uses (a stored original with a hash) and the settings each channel
// accepts. One function turns a draft into the snapshot a version keeps and its hash, inside the transaction of the write.

type Providers = Readonly<Record<string, HealthProvider>>;
type Defaults = Readonly<Record<string, string | number | boolean>>;

const MAX_ISSUES = 20;

// The media states that hold a hash: the set of `media_assets_live_hash_check`.
const HASHED_MEDIA = "state IN ('uploaded', 'scanning', 'processing', 'ready')";

const unprocessable = (reason: string): Refusal =>
  new Refusal("unprocessable_content", `draft refused: ${reason}`, { details: { reason } });

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

async function hashesOfMedia(
  tx: TenantTx,
  workspaceId: string,
  draft: Draft,
): Promise<Record<string, string>> {
  const ids = [...new Set(draft.variants.flatMap((v) => v.media.map((m) => m.media_id.toLowerCase())))];
  if (ids.length === 0) return {};
  const found = await tx.query<{ id: string; sha256: string }>(
    `SELECT id, encode(sha256, 'hex') AS sha256 FROM app.media_assets
     WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND ${HASHED_MEDIA}`,
    [workspaceId, ids],
  );
  if (found.rows.length !== ids.length) throw unprocessable("media_unavailable");
  return Object.fromEntries(found.rows.map((row) => [row.id, row.sha256]));
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
  const media = await hashesOfMedia(tx, workspaceId, draft);
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
