import type { SealedSecret } from "@shoutory/core/crypto";

/** What an attempt did at the provider: nothing, possibly something (unknown), or confirmed something. */
export type Effect = "none" | "possible" | "confirmed";

/** The non-success result classes of the operation ledger; success is `ok` with its `effect`. */
export type ProviderErrorClass =
  | "retryable_before_send"
  | "retryable_after_send"
  | "rate_limited"
  | "auth_revoked"
  | "permanent"
  | "unknown";

/**
 * The tokens a refresh obtained, as RFC 6749 section 5.1 answers them: an access token with its lifetime and, only when
 * the provider rotated it, a new refresh token. They stay sealed (printing one gives `[redacted]`).
 */
export interface RefreshedCredential {
  readonly accessToken: SealedSecret;
  readonly refreshToken?: SealedSecret;
  readonly expiresInSeconds: number;
}

/** The account a connect reached, as the provider names it. */
export interface AccountIdentity {
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatar?: string;
}

/** Every adapter method answers with this and never throws a raw error; throwing is only for bugs. */
export interface ProviderResult {
  readonly ok: boolean;
  /** Present on a successful refresh or code exchange only. */
  readonly credential?: RefreshedCredential;
  /** Present on a successful identity read only. */
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

/** What the adapter knows about a failed attempt. The class is the adapter's call, never read from a body. */
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

/**
 * A failure result. It reads nothing from a response body: whatever a body holds as an id is not proof that anything was
 * created, so it carries no `externalId` or `permalink`. The provider code is kept only in the shape of a code.
 */
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
