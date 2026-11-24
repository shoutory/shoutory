import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { createCredentialService } from "../../src/channels/credentials.js";
import { createLogger } from "../../src/logging/logger.js";

// What the ledger tests give a channel: its credential, stored the way a connect stores it (the credential service and its
// definers, sealed under the key ring below), never a raw insert. The worker opens this credential for every claimed
// operation, so a channel a test plants for an operation to send on has one. The token is the one a test names, or one
// that says whose it is.
export const ledgerKeys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

interface Channel {
  readonly workspace: string;
  readonly provider: string;
  readonly account: string;
  /** The instance host a provider whose accounts live on user-chosen servers stores with the channel. */
  readonly host?: string;
  readonly token?: string;
}

/** The token a channel planted without one carries. */
export const tokenOfAccount = (account: string): string => `token-of-${account}`;

/**
 * Connects the channel and stores its first credential through the credential service, as a job principal of the
 * workspace; answers the channel's id. A channel that exists already (a row a test inserted) gets its credential.
 */
export async function connectChannel(pool: AppPool, channel: Channel): Promise<string> {
  const credentials = createCredentialService({
    pool,
    keys: ledgerKeys,
    pepper: new SealedSecret("ledger-test-pepper-0123456789abcdef"),
    fetch,
    now: () => new Date(),
    logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
    providers: {},
  });
  const stored = await credentials.connect({
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
