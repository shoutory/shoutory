import { z } from "zod";

const MAX_TOKEN_CHARS = 8192;
const MAX_LIFETIME_SECONDS = 31_536_000;
const token = z.string().min(1).max(MAX_TOKEN_CHARS);

export const channelTokenSchema = z.strictObject({
  access_token: token,
  refresh_token: token.optional(),
  dpop_private_jwk: z
    .record(z.string().max(64), z.unknown())
    .refine((key) => JSON.stringify(key).length <= MAX_TOKEN_CHARS)
    .optional(),
  issuer: z
    .url({ protocol: /^https$/ })
    .max(512)
    .optional(),
});
export type ChannelToken = z.infer<typeof channelTokenSchema>;

/** The token answer of RFC 6749 section 5.1. */
export const refreshAnswerSchema = z.object({
  access_token: token,
  expires_in: z.number().int().min(1).max(MAX_LIFETIME_SECONDS),
  refresh_token: token.optional(),
});

export interface RefreshAnswer {
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
}

// A failed refresh never adopts a token it did not obtain. A missing refresh token keeps the old one, and the DPoP key
// is never replaced by a refresh.
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

export type RefreshClass = "transient" | "rate_limited" | "config" | "revoked";

const TRANSIENT_CLASSES: ReadonlySet<string> = new Set([
  "retryable_before_send",
  "retryable_after_send",
  "unknown",
]);

// A code the manifest does not map (or no code) is `config`: only a mapped `revoked` can disconnect a channel.
export function refreshClassOf(
  failure: { readonly errorClass?: string | undefined; readonly providerCode?: string | undefined },
  map: Readonly<Record<string, RefreshClass>>,
): RefreshClass {
  if (failure.errorClass === "rate_limited") return "rate_limited";
  if (failure.errorClass !== undefined && TRANSIENT_CLASSES.has(failure.errorClass)) return "transient";
  return (failure.providerCode === undefined ? undefined : map[failure.providerCode]) ?? "config";
}

// A transient failure leaves the attempt `unknown` because a rotating provider may have spent the token.
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
