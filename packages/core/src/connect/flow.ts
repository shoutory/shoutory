import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// The pure rules of an OAuth connect: an unguessable state stored only as its digest, a PKCE S256 pair, the object sealed
// with the flow, the callback's `iss` rule (RFC 9207) and the one way a provider's error text is shown.

const STATE_BYTES = 32;
const VERIFIER_BYTES = 32;
const ERROR_TEXT_LENGTH = 200;

/** The digest a state is stored as: SHA-256 of its bytes (the state travels as base64url). */
export const digestOfState = (state: string): Buffer =>
  createHash("sha256").update(Buffer.from(state, "base64url")).digest();

/** A fresh state of 256 bits and the digest to store; the state itself is never stored. */
export function newState(): { state: string; digest: Buffer } {
  const state = randomBytes(STATE_BYTES).toString("base64url");
  return { state, digest: digestOfState(state) };
}

/** A PKCE pair (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** What a flow seals: the PKCE verifier and nothing else (a DPoP key or a pushed request arrive with a provider that needs them). */
export const flowObjectSchema = z.strictObject({
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});

/**
 * Whether the callback's `iss` is acceptable: when the adapter expects an issuer, the callback must carry exactly it;
 * when none is expected, any value (or none) passes.
 */
export const issuerAccepted = (expected: string | undefined, received: string | undefined): boolean =>
  expected === undefined || received === expected;

/** A provider's error text as plain text: control characters removed and at most 200 characters; markup stays literal. */
export const providerErrorText = (raw: string | undefined): string =>
  (raw ?? "").replace(/\p{Cc}/gu, "").slice(0, ERROR_TEXT_LENGTH);
