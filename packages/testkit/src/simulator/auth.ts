import { createHash, createPublicKey, type KeyObject, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// RFC 7636: a verifier is 43 to 128 unreserved characters, and only S256 is accepted, never `plain`.
const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  return sameText(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);
}

// RFC 9449: the header carries the public key only, never a private member.
const publicJwk = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().max(64),
  y: z.string().max(64),
});
const proofHeader = z.object({ typ: z.literal("dpop+jwt"), alg: z.literal("ES256"), jwk: publicJwk });
const proofClaims = z.object({
  jti: z.string().min(1).max(256),
  htm: z.string(),
  htu: z.string(),
  iat: z.number().int(),
  nonce: z.string().optional(),
});

const IAT_WINDOW_S = 60;

const MAX_REMEMBERED = 1000;

// The fake only runs inside tests, so the oldest entry is dropped instead of letting a long run grow the set.
export function rememberBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value as string);
}

export type DpopVerdict = "ok" | "invalid_dpop_proof" | "use_dpop_nonce";

export interface DpopExpectation {
  readonly method: string;
  /** Without query or fragment. */
  readonly url: string;
  readonly now: Date;
  readonly nonce: string;
  readonly seen: Set<string>;
}

function decodedJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function importedKey(jwk: z.infer<typeof publicJwk>): KeyObject | undefined {
  try {
    return createPublicKey({ key: jwk, format: "jwk" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_CRYPTO_INVALID_JWK")
      return undefined;
    throw error;
  }
}

function signatureHolds(parts: readonly string[], jwk: z.infer<typeof publicJwk>): boolean {
  const key = importedKey(jwk);
  if (key === undefined) return false;
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  // A JWS signature is the raw r and s values, not DER.
  return verify(
    "sha256",
    signed,
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2] ?? "", "base64url"),
  );
}

// RFC 9449: a well-formed proof without the current nonce answers `use_dpop_nonce`.
export function checkDpopProof(proof: string, expected: DpopExpectation): DpopVerdict {
  const parts = proof.split(".");
  const header = proofHeader.safeParse(decodedJson(parts[0] ?? ""));
  const claims = proofClaims.safeParse(decodedJson(parts[1] ?? ""));
  if (parts.length !== 3 || !header.success || !claims.success) return "invalid_dpop_proof";
  const { jti, htm, htu, iat, nonce } = claims.data;
  const inWindow = Math.abs(iat - expected.now.getTime() / 1000) <= IAT_WINDOW_S;
  const sound =
    signatureHolds(parts, header.data.jwk) &&
    htm === expected.method &&
    htu === expected.url &&
    inWindow &&
    !expected.seen.has(jti);
  if (!sound) return "invalid_dpop_proof";
  if (nonce === undefined || !sameText(nonce, expected.nonce)) return "use_dpop_nonce";
  rememberBounded(expected.seen, jti);
  return "ok";
}
