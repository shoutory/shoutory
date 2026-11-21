import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "./result.js";

/**
 * What an adapter is given besides its input: the outbound `fetch` (the egress client, passed in and never imported, so
 * an adapter cannot reach the network any other way) and the clock (code takes the time as an input).
 */
export interface AdapterContext {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/** The smallest commit input; later slices widen it without removing a field. */
export interface CommitInput {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly replyToExternalId?: string;
  readonly mediaIds?: readonly string[];
}

/** What a token refresh sends: the refresh token in use, still sealed until the one call that puts it on the wire. */
export interface RefreshInput {
  readonly refreshToken: SealedSecret;
}

/** What a channel health read sends: the access token in use, still sealed until the one call that puts it on the wire. */
export interface InspectInput {
  readonly accessToken: SealedSecret;
}

/** A post that already exists at the provider, found by its id or, where the provider allows it, by the key. */
export interface RemotePost {
  readonly externalId?: string;
  readonly idempotencyKey?: string;
}

/**
 * The provider side of a publish. Every method answers with a `ProviderResult` and never throws a raw error; throwing is
 * for bugs only. `edit` and `refresh` exist only where the manifest declares the capability.
 */
export interface ProviderAdapter {
  prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult>;
  commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult>;
  readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  delete(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  edit?(context: AdapterContext, post: RemotePost, input: { readonly text: string }): Promise<ProviderResult>;
  refresh?(context: AdapterContext, input: RefreshInput): Promise<ProviderResult>;
  inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult>;
}
