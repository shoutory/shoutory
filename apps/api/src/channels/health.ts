import { type Health, healthOf } from "@shoutory/core/channels/health";
import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "@shoutory/provider-sdk/result";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { type ChannelProvider, CredentialError, type CredentialService } from "./credentials.js";

export type HealthProvider = ChannelProvider;

export interface HealthCheckerDeps {
  readonly credentials: CredentialService;
  readonly now: () => Date;
}

export function createHealthChecker(deps: HealthCheckerDeps) {
  const failing = (provider: HealthProvider, health: Health) => ({
    health,
    snapshot: snapshotOf(provider.manifest, deps.now()),
  });

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
    const egress = await deps.credentials.egressFor(workspaceId, channelId, provider);
    return provider.adapter.inspect(
      { fetch: egress.fetch, now: deps.now },
      { accessToken, ...(egress.instanceHost === undefined ? {} : { instanceHost: egress.instanceHost }) },
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
