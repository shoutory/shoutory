import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "./result.js";

// The egress client is passed in and never imported, so an adapter cannot reach the network any other way.
export interface AdapterContext {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly media?: MediaReader;
}

// What the worker holds of the operation's pinned media: the facts to check a file with, and the bytes of one position
// on request. A read refuses a position the operation does not pin and an object that differs from its pin.
export interface MediaItem {
  readonly mime: string;
  readonly size: number;
  readonly altText: string | null;
}

export interface MediaFile {
  readonly bytes: Uint8Array;
  readonly altText: string | null;
}

// Thrown by a reader for a position it will not serve; any other error is a defect and travels on.
export class MediaReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaReadError";
  }
}

export interface MediaReader {
  readonly items: readonly MediaItem[];
  read(position: number): Promise<MediaFile>;
}

// The token stays sealed until the one call that puts it on the wire. The instance host is for providers whose accounts
// live on user-chosen servers.
export interface AccountAccess {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
}

// The post's settings as the manifest's `providerDefault` declares them, and the locale of the variant being sent.
type PostSettings = Readonly<Record<string, string | number | boolean>>;

interface PostFacts {
  readonly settings?: PostSettings;
  readonly locale?: string | null;
}

export interface CommitInput extends PostFacts {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly account?: AccountAccess;
  readonly replyToExternalId?: string;
  readonly mediaIds?: readonly string[];
}

export interface PollInput {
  readonly mediaIds: readonly string[];
  readonly account?: AccountAccess;
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
  /** Asks the provider whether media it is still processing are ready; a read, so it never has an effect. */
  pollMedia?(context: AdapterContext, input: PollInput): Promise<ProviderResult>;
  readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  delete(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  edit?(
    context: AdapterContext,
    post: RemotePost,
    input: PostFacts & { readonly text: string },
  ): Promise<ProviderResult>;
  refresh?(context: AdapterContext, input: RefreshInput): Promise<ProviderResult>;
  inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult>;
  connect?: ConnectAdapter;
}
