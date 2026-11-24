import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "./result.js";

// The egress client is passed in and never imported, so an adapter cannot reach the network any other way.
export interface AdapterContext {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

// The token stays sealed until the one call that puts it on the wire. The instance host is for providers whose accounts
// live on user-chosen servers.
export interface AccountAccess {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
}

export interface CommitInput {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly account?: AccountAccess;
  readonly replyToExternalId?: string;
  readonly mediaIds?: readonly string[];
}

export interface RefreshInput {
  readonly refreshToken: SealedSecret;
}

export interface InspectInput {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
}

export interface AppCredentials {
  readonly clientId: string;
  readonly clientSecret: SealedSecret;
}

// `redirectUri` already carries any instance host.
export interface AuthorizeInput {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly instanceHost?: string;
  readonly app?: AppCredentials;
}

export interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: SealedSecret;
  readonly redirectUri: string;
  readonly instanceHost?: string;
  readonly app?: AppCredentials;
}

export interface RegisterAppInput {
  readonly instanceHost: string;
  readonly redirectUri: string;
}

export interface IdentityInput {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
}

// `issuer` is the one a callback must carry (RFC 9207). `authorize` builds the URL only and makes no network call.
export interface ConnectAdapter {
  readonly issuer?: string;
  // Only for a provider whose accounts live on user-chosen servers. An instance that cannot take part is a result with
  // the code `instance_unsupported`.
  registerApp?(context: AdapterContext, input: RegisterAppInput): Promise<ProviderResult>;
  authorize(input: AuthorizeInput): string;
  exchangeCode(context: AdapterContext, input: ExchangeInput): Promise<ProviderResult>;
  identity(context: AdapterContext, input: IdentityInput): Promise<ProviderResult>;
}

export type AdapterMap = Readonly<Record<string, ProviderAdapter>>;

export interface RemotePost {
  readonly externalId?: string;
  readonly idempotencyKey?: string;
  readonly account?: AccountAccess;
}

// Every method answers with a `ProviderResult` and never throws a raw error; throwing is for bugs only.
export interface ProviderAdapter {
  prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult>;
  commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult>;
  readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  delete(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  edit?(context: AdapterContext, post: RemotePost, input: { readonly text: string }): Promise<ProviderResult>;
  refresh?(context: AdapterContext, input: RefreshInput): Promise<ProviderResult>;
  inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult>;
  connect?: ConnectAdapter;
}
