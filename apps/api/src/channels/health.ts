import { type Health, healthOf } from "@shoutory/core/channels/health";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { CredentialError, type CredentialService, deadlineFetch } from "./credentials.js";

/** The provider behind a channel: its adapter and its manifest (the snapshot is made from it). */
export interface HealthProvider {
  readonly adapter: ProviderAdapter;
  readonly manifest: Manifest;
}

export interface HealthCheckerDeps {
  readonly credentials: CredentialService;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/**
 * The on-demand read of a channel's health (R542). A due access token is refreshed first through the credential
 * service: a refresh retried later reads `degraded`, any other refresh that did not succeed reads `failing`, and in
 * neither case is the provider read. What the read answers is classed by `healthOf`; no reading moves a connection state.
 * It returns the health and the capability snapshot to record with it, and holds no database transaction while the
 * provider is called (AGENTS 3.7); the caller records it in one of its own.
 */
export function createHealthChecker(deps: HealthCheckerDeps) {
  const failing = (provider: HealthProvider, health: Health) => ({
    health,
    snapshot: snapshotOf(provider.manifest, deps.now()),
  });

  async function observe(workspaceId: string, channelId: string, provider: HealthProvider) {
    try {
      let token = await deps.credentials.open(workspaceId, channelId);
      if (token.refreshDue) {
        const outcome = await deps.credentials.refresh(workspaceId, channelId);
        if (outcome.kind === "retry_later") return failing(provider, "degraded");
        if (outcome.kind !== "refreshed" && outcome.kind !== "lost_race") return failing(provider, "failing");
        token = await deps.credentials.open(workspaceId, channelId);
      }
      const result = await provider.adapter.inspect(
        { fetch: deadlineFetch(deps.fetch), now: deps.now },
        { accessToken: token.accessToken },
      );
      return { health: healthOf(result), snapshot: snapshotOf(provider.manifest, deps.now()) };
    } catch (error) {
      // A channel with no usable credential cannot be read: that is a failing channel, not a fault of the request.
      if (error instanceof CredentialError) return failing(provider, "failing");
      throw error;
    }
  }

  return { observe };
}

export type HealthChecker = ReturnType<typeof createHealthChecker>;
