import { type Health, healthOf } from "@shoutory/core/channels/health";
import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { CredentialError, type CredentialService, deadlineFetch } from "./credentials.js";

export interface HealthProvider {
  readonly adapter: ProviderAdapter;
  readonly manifest: Manifest;
}

export interface HealthCheckerDeps {
  readonly credentials: CredentialService;
  readonly fetch: typeof fetch;
  readonly fetchFor?: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly now: () => Date;
}

export function createHealthChecker(deps: HealthCheckerDeps) {
  const failing = (provider: HealthProvider, health: Health) => ({
    health,
    snapshot: snapshotOf(provider.manifest, deps.now()),
  });

  // Only a provider whose host is the channel's own needs the host read; every other keeps its manifest's hosts.
  const instanceHostOf = (workspaceId: string, channelId: string, provider: HealthProvider) =>
    provider.manifest.egressHostSource === "channel"
      ? deps.credentials.instanceHostOf(workspaceId, channelId)
      : Promise.resolve(undefined);

  const snapshotWith = (provider: HealthProvider, result: ProviderResult) => {
    const snapshot = snapshotOf(provider.manifest, deps.now());
    return result.limits === undefined
      ? snapshot
      : { ...snapshot, limits: { ...snapshot.limits, ...result.limits } };
  };

  async function inspect(
    workspaceId: string,
    channelId: string,
    provider: HealthProvider,
    accessToken: SealedSecret,
  ): Promise<ProviderResult> {
    const host = await instanceHostOf(workspaceId, channelId, provider);
    const egress = deps.fetchFor?.(provider.manifest, host) ?? deps.fetch;
    return provider.adapter.inspect(
      { fetch: deadlineFetch(egress), now: deps.now },
      { accessToken, ...(host === undefined ? {} : { instanceHost: host }) },
    );
  }

  async function observe(workspaceId: string, channelId: string, provider: HealthProvider) {
    try {
      let token = await deps.credentials.open(workspaceId, channelId);
      if (token.refreshDue) {
        const outcome = await deps.credentials.refresh(workspaceId, channelId);
        if (outcome.kind === "retry_later") return failing(provider, "degraded");
        if (outcome.kind !== "refreshed" && outcome.kind !== "lost_race") return failing(provider, "failing");
        token = await deps.credentials.open(workspaceId, channelId);
      }
      const result = await inspect(workspaceId, channelId, provider, token.accessToken);
      return { health: healthOf(result), snapshot: snapshotWith(provider, result) };
    } catch (error) {
      // A channel with no usable credential cannot be read: that is a failing channel, not a fault of the request.
      if (error instanceof CredentialError) return failing(provider, "failing");
      throw error;
    }
  }

  return { observe };
}

export type HealthChecker = ReturnType<typeof createHealthChecker>;
