import type { AccountAccess } from "@shoutory/provider-sdk/adapter";
import type { CredentialService, Usable } from "../../channels/credentials.js";
import type { ChannelFacts, Operation } from "./held.js";

export type Access =
  | { readonly kind: "ok"; readonly account: AccountAccess }
  | Exclude<Usable, { readonly kind: "ok" }>;

export const factsOf = (channel: ChannelFacts) => ({
  instanceHost: channel.instance_host ?? undefined,
  providerAccountId: channel.provider_account_id ?? undefined,
});

// The token is refreshed first when it is due, so a send never goes out with one the provider has already let expire.
export async function accessOf(
  credentials: CredentialService,
  operation: Operation,
  channel: { readonly instanceHost?: string | undefined; readonly providerAccountId?: string | undefined },
): Promise<Access> {
  const usable = await credentials.usable(operation.workspace_id, operation.channel_id);
  if (usable.kind !== "ok") return usable;
  const { instanceHost, providerAccountId } = channel;
  return {
    kind: "ok",
    account: {
      accessToken: usable.accessToken,
      ...(instanceHost === undefined ? {} : { instanceHost }),
      ...(providerAccountId === undefined ? {} : { providerAccountId }),
      ...(usable.dpopKey === undefined ? {} : { dpopKey: usable.dpopKey }),
    },
  };
}
