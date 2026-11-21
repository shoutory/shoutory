import { z } from "zod";

// The pure rules of a channel's credential (R537 (1)): what is stored, what a refresh answer may change, which class a
// failure is and what each class does to the channel. No database, no provider, no clock; the service that runs them is
// in the API package.

/** One `channel_token` generation: the sealed plaintext, validated at the boundary (R532 (8)). */
// Every stored or accepted value has a bound (AGENTS 6.6): a token is at most 8192 characters, the DPoP key at most
// 8192 characters once serialized, a token's lifetime at most one year.
const MAX_TOKEN_CHARS = 8192;
const MAX_LIFETIME_SECONDS = 31_536_000;
const token = z.string().min(1).max(MAX_TOKEN_CHARS);

export const channelTokenSchema = z.strictObject({
  access_token: token,
  refresh_token: token.optional(),
  // A provider-bound DPoP key travels with its token.
  dpop_private_jwk: z
    .record(z.string().max(64), z.unknown())
    .refine((key) => JSON.stringify(key).length <= MAX_TOKEN_CHARS)
    .optional(),
});
export type ChannelToken = z.infer<typeof channelTokenSchema>;

/** The token answer of RFC 6749 section 5.1, bounded; an adapter refuses an answer that does not parse as unknown. */
export const refreshAnswerSchema = z.object({
  access_token: token,
  expires_in: z.number().int().min(1).max(MAX_LIFETIME_SECONDS),
  refresh_token: token.optional(),
});

/** What a provider's refresh answer carries (RFC 6749 section 5.1): the refresh token is optional. */
export interface RefreshAnswer {
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
}

/**
 * The generation a refresh answer produces, or nothing when the refresh failed or the answer holds no access token: a
 * failed refresh never adopts a token it did not obtain. A missing refresh token keeps the old one, and the DPoP key
 * is never replaced by a refresh.
 */
export function adoptRefresh(
  current: ChannelToken,
  answer: RefreshAnswer | undefined,
): ChannelToken | undefined {
  if (!answer || answer.access_token === "") return undefined;
  const refresh = answer.refresh_token ?? current.refresh_token;
  return {
    ...current,
    access_token: answer.access_token,
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
  };
}

/** The four classes of a refresh failure. */
export type RefreshClass = "transient" | "rate_limited" | "config" | "revoked";

const TRANSIENT_CLASSES: ReadonlySet<string> = new Set([
  "retryable_before_send",
  "retryable_after_send",
  "unknown",
]);

/**
 * The class of a failed refresh: a 429 and a network or 5xx failure follow the adapter's result class, anything else
 * follows the manifest's `refreshErrorMap` by the provider's code, and a code the manifest does not map (or no code) is
 * `config`: only a mapped `revoked` can disconnect a channel (R538 (B)).
 */
export function refreshClassOf(
  failure: { readonly errorClass?: string | undefined; readonly providerCode?: string | undefined },
  map: Readonly<Record<string, RefreshClass>>,
): RefreshClass {
  if (failure.errorClass === "rate_limited") return "rate_limited";
  if (failure.errorClass !== undefined && TRANSIENT_CLASSES.has(failure.errorClass)) return "transient";
  return (failure.providerCode === undefined ? undefined : map[failure.providerCode]) ?? "config";
}

/**
 * What a failure writes: the attempt marker (a transient failure leaves it `unknown`, since a rotating provider may have
 * spent the token) and, only for a revocation, the state reason that moves the channel to `needs_reconnect`. A
 * revocation that follows an earlier attempt still unknown with the same digest is `refresh_token_rotated_unknown`
 * (flows 1.3).
 */
export function refreshFailureOutcome(klass: RefreshClass, priorAttemptUnknown: boolean) {
  const marker = klass === "transient" || klass === "rate_limited" ? "unknown" : "failed";
  const stateReason =
    klass === "revoked"
      ? priorAttemptUnknown
        ? "refresh_token_rotated_unknown"
        : "revoked_confirmed"
      : null;
  return { marker, stateReason } as const;
}
