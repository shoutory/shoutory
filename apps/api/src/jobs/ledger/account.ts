import type { AccountAccess } from "@shoutory/provider-sdk/adapter";
import type { CredentialService, Usable } from "../../channels/credentials.js";
import type { Operation } from "./held.js";

export type Access =
  | { readonly kind: "ok"; readonly account: AccountAccess }
  | Exclude<Usable, { readonly kind: "ok" }>;

// The token is refreshed first when it is due, so a send never goes out with one the provider has already let expire.
export async function accessOf(
  credentials: CredentialService,
  operation: Operation,
  instanceHost: string | null | undefined,
): Promise<Access> {
  const usable = await credentials.usable(operation.workspace_id, operation.channel_id);
  if (usable.kind !== "ok") return usable;
  const host = instanceHost ?? undefined;
  return {
    kind: "ok",
    account: { accessToken: usable.accessToken, ...(host === undefined ? {} : { instanceHost: host }) },
  };
}
