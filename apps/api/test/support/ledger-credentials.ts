import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import type { AdapterMap } from "@shoutory/provider-sdk/adapter";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { Registry } from "@shoutory/provider-sdk/registry";
import { channelProvidersOf, createCredentialService } from "../../src/channels/credentials.js";
import { createLogger } from "../../src/logging/logger.js";

// The worker opens a credential for every claimed operation, so a planted channel gets one stored the way a real
// connect stores it, never by a raw insert.
export const ledgerKeys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

type WorkerFetch = (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;

interface Channel {
  readonly workspace: string;
  readonly provider: string;
  readonly account: string;
  readonly host?: string;
  readonly token?: string;
}

export const tokenOfAccount = (account: string): string => `token-of-${account}`;

// The service a worker sends with: it opens, and refreshes when due, the credential of every claimed operation.
export const ledgerCredentials = (
  pool: AppPool,
  wiring: { registry?: Registry; adapters?: AdapterMap; fetchFor?: WorkerFetch } = {},
) =>
  createCredentialService({
    pool,
    keys: ledgerKeys,
    pepper: new SealedSecret("ledger-test-pepper-0123456789abcdef"),
    fetch,
    ...(wiring.fetchFor === undefined ? {} : { fetchFor: wiring.fetchFor }),
    now: () => new Date(),
    logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
    providers:
      wiring.registry === undefined ? {} : channelProvidersOf(wiring.registry, wiring.adapters ?? {}),
  });

export async function connectChannel(pool: AppPool, channel: Channel): Promise<string> {
  const stored = await ledgerCredentials(pool).connect({
    principal: { principalKind: "job", principalId: crypto.randomUUID(), workspaceIds: [channel.workspace] },
    workspaceId: channel.workspace,
    identity: {
      providerId: channel.provider,
      accountKind: "profile",
      providerAccountId: channel.account,
      displayName: channel.account,
      ...(channel.host === undefined ? {} : { instanceHost: channel.host }),
    },
    tokens: { access_token: channel.token ?? tokenOfAccount(channel.account) },
    accessExpiresAt: null,
    snapshot: {
      manifestDigest: "ledger-test",
      apiVersion: "v1",
      sunsetAt: null,
      capabilities: [],
      limits: {},
    },
    audit: { requestId: `ledger-test-${channel.account}`, ipHmac: null },
  });
  return stored.channelId;
}
