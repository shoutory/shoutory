import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const ERROR_TEXT_LENGTH = 200;

export const digestOfState = (state: string): Buffer =>
  createHash("sha256").update(Buffer.from(state, "base64url")).digest();

export function newState(): { state: string; digest: Buffer } {
  const state = randomBytes(STATE_BYTES).toString("base64url");
  return { state, digest: digestOfState(state) };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// The key and the issuer are for a provider whose authorization server is found at the start; the hint is what the person
// typed to say which account they mean.
export const flowObjectSchema = z.strictObject({
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  dpop_private_jwk: z.record(z.string().max(64), z.unknown()).optional(),
  issuer: z
    .url({ protocol: /^https$/ })
    .max(512)
    .optional(),
  login_hint: z.string().min(1).max(512).optional(),
});
export type FlowObject = z.infer<typeof flowObjectSchema>;

export const issuerAccepted = (expected: string | undefined, received: string | undefined): boolean =>
  expected === undefined || received === expected;

export const providerErrorText = (raw: string | undefined): string =>
  (raw ?? "").replace(/\p{Cc}/gu, "").slice(0, ERROR_TEXT_LENGTH);
