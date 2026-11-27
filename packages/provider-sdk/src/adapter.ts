import type { SealedSecret } from "@shoutory/core/crypto";
import type { ProviderResult } from "./result.js";

// The egress client is passed in and never imported, so an adapter cannot reach the network any other way.
export interface AdapterContext {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly media?: MediaReader;
  // The TXT records of a name, read under the operator's egress policy; the only way an adapter reads DNS.
  readonly resolveTxt?: ((name: string) => Promise<string[]>) | undefined;
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
// live on user-chosen servers; the account id is the provider's own (a repository id, a chat id) for the calls that name
// it; the DPoP key is for providers that bind a token to one.
export interface AccountAccess {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
  readonly providerAccountId?: string;
  readonly dpopKey?: SealedSecret;
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
  readonly dpopKey?: SealedSecret;
  readonly issuer?: string;
  readonly instanceHost?: string;
  readonly app?: AppCredentials;
}

export interface InspectInput {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
  readonly providerAccountId?: string;
  readonly dpopKey?: SealedSecret;
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
  readonly loginHint?: string;
}

// What a provider that pushes the request and binds a key hands back besides the URL: the pushed request's URI, the
// key and the authorization server's issuer, which the flow keeps for the callback and the exchange.
export interface AuthorizeResult {
  readonly url: string;
  readonly requestUri?: string;
  readonly dpopKey?: SealedSecret;
  readonly issuer?: string;
}

export interface ExchangeInput {
  readonly code: string;
  readonly codeVerifier: SealedSecret;
  readonly redirectUri: string;
  readonly instanceHost?: string;
  readonly app?: AppCredentials;
  readonly dpopKey?: SealedSecret;
  readonly issuer?: string;
  readonly requestUri?: string;
  readonly loginHint?: string;
}

// No host for an app of the whole instance (`appKind: "provider"`).
export interface RegisterAppInput {
  readonly instanceHost?: string;
  readonly redirectUri: string;
}

export interface IdentityInput {
  readonly accessToken: SealedSecret;
  readonly instanceHost?: string;
  readonly dpopKey?: SealedSecret;
}

// What a pasted secret is: a webhook URL, or the token of a bot the person made.
export type SecretKind = "bot_token" | "webhook_url";

export interface VerifySecretInput {
  readonly kind: SecretKind;
  readonly secret: SealedSecret;
}

export interface PollChallengeInput {
  readonly botToken: SealedSecret;
  readonly offset: number;
}

export interface PublicDocumentsInput {
  readonly publicOrigin: string;
  readonly app?: AppCredentials;
}

// `issuer` is the one a callback must carry (RFC 9207); a provider whose server is only known at the start returns it from
// `authorize` instead. `authorize` may push the request (an outbound call), so the caller holds no transaction.
export interface ConnectAdapter {
  readonly issuer?: string;
  // `provider`: one app of the whole instance (its key is made on first use), not one per server or workspace.
  readonly appKind?: "provider";
  // Only for a provider whose accounts live on user-chosen servers. An instance that cannot take part is a result with
  // the code `instance_unsupported`.
  registerApp?(context: AdapterContext, input: RegisterAppInput): Promise<ProviderResult>;
  // The three of an OAuth provider; a provider that connects from a pasted secret declares none of them. `identity` may
  // be left out by one whose `exchangeCode` answers the account.
  // A sign-in that cannot start (a handle nobody has, a server that cannot take part) is a failed result, like any call.
  authorize?(context: AdapterContext, input: AuthorizeInput): Promise<AuthorizeResult | ProviderResult>;
  exchangeCode?(context: AdapterContext, input: ExchangeInput): Promise<ProviderResult>;
  identity?(context: AdapterContext, input: IdentityInput): Promise<ProviderResult>;
  /** The documents the provider's server fetches from this app (client metadata, key set), by file name. */
  publicDocuments?(input: PublicDocumentsInput): Promise<Readonly<Record<string, unknown>>>;
  /** Checks a pasted secret against the provider and answers the account it belongs to. */
  verifySecret?(context: AdapterContext, input: VerifySecretInput): Promise<ProviderResult>;
  /** Reads the bot's updates after `offset`; a read, so it never has an effect. */
  pollChallenge?(context: AdapterContext, input: PollChallengeInput): Promise<ProviderResult>;
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
  /** Reads the text and content warning a post holds, to compare an edit that may have been applied; a read. */
  readSource?(context: AdapterContext, post: RemotePost): Promise<ProviderResult>;
  /** The post settings with the adapter's own defaults filled in, as a source read reports them. */
  settingsWithDefaults?(settings: PostSettings): PostSettings;
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
