import type { SealedSecret } from "@shoutory/core/crypto";

export type Effect = "none" | "possible" | "confirmed";

export type ProviderErrorClass =
  | "retryable_before_send"
  | "retryable_after_send"
  | "rate_limited"
  | "auth_revoked"
  | "permanent"
  | "unknown";

// As RFC 6749 section 5.1 answers them. A token the provider never expires has no `expiresInSeconds`, and the credential
// is stored with no expiry.
export interface RefreshedCredential {
  readonly accessToken: SealedSecret;
  readonly refreshToken?: SealedSecret;
  readonly expiresInSeconds?: number;
}

export interface AccountIdentity {
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatar?: string;
}

export interface ReadLimit {
  readonly value: number;
  readonly source: string;
  readonly checked: string;
}

export interface RegisteredApp {
  readonly clientId: string;
  readonly clientSecret: SealedSecret;
}

export interface ProviderResult {
  readonly ok: boolean;
  readonly app?: RegisteredApp;
  /** Present on a successful identity or channel read of a provider whose instances state their own limits. */
  readonly limits?: Readonly<Record<string, ReadLimit>>;
  readonly credential?: RefreshedCredential;
  readonly identity?: AccountIdentity;
  /** Present on a successful channel read: what the provider's answer says of the channel (`ok` when absent). */
  readonly health?: "ok" | "degraded";
  readonly effect: Effect;
  readonly externalId?: string;
  readonly permalink?: string;
  readonly errorClass?: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  /** The HTTP status of a failed answer, so core can compare it with the manifest's `absentAnswers`. */
  readonly httpStatus?: number;
  /** A read-back whose answer is itself "the post is not there" (no status says so). */
  readonly absent?: boolean;
}

// The class is the adapter's call, never read from a body.
export interface ErrorInput {
  readonly effect: Effect;
  readonly errorClass: ProviderErrorClass;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

// An error that may have taken effect can only be unknown or retried after a read-back; a confirmed effect is not an error.
const CLASSES_AFTER_POSSIBLE_EFFECT: readonly ProviderErrorClass[] = ["unknown", "retryable_after_send"];

export const MAX_RETRY_DELAY_MS = 86_400_000;

// A delay outside a whole number of milliseconds up to a day is dropped, so the ledger uses its own back-off.
function isUsableDelay(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= MAX_RETRY_DELAY_MS;
}

function assertPair({ effect, errorClass }: ErrorInput): void {
  const valid =
    effect === "none" || (effect === "possible" && CLASSES_AFTER_POSSIBLE_EFFECT.includes(errorClass));
  if (!valid) throw new Error(`an error with effect ${effect} cannot have class ${errorClass}`);
}

// It reads nothing from a response body: whatever a body holds as an id is not proof that anything was created, so it
// carries no `externalId` or `permalink`.
export function errorResult(input: ErrorInput): ProviderResult {
  assertPair(input);
  const { effect, errorClass, providerCode, retryAfterMs } = input;
  return {
    ok: false,
    effect,
    errorClass,
    ...(isUsableDelay(retryAfterMs) ? { retryAfterMs } : {}),
    ...(providerCode !== undefined && SAFE_CODE.test(providerCode) ? { providerCode } : {}),
  };
}
