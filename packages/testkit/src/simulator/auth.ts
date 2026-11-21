import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// RFC 7636 section 4.1: 43 to 128 characters from the unreserved set.
const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 section 4.6, method S256: the challenge is base64url(SHA-256(ASCII verifier)); `plain` is never accepted. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_SHAPE.test(verifier)) return false;
  return sameText(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);
}

// RFC 9449 section 4.2: typ dpop+jwt, an asymmetric alg and the public key in the header (never a private member).
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

export type DpopVerdict = "ok" | "invalid_dpop_proof" | "use_dpop_nonce";

export interface DpopExpectation {
  readonly method: string;
  /** The request URL without query or fragment. */
  readonly url: string;
  readonly now: Date;
  /** The nonce the server last gave out. */
  readonly nonce: string;
  /** The `jti` values already used; a proof that passes is added. */
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

function signatureHolds(parts: readonly string[], jwk: z.infer<typeof publicJwk>): boolean {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  // A JWS signature is the raw r and s values, not DER.
  return verify(
    "sha256",
    signed,
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2] ?? "", "base64url"),
  );
}

/**
 * RFC 9449 sections 4.3 and 8: the proof's type, algorithm and key, its signature, `htm`, `htu`, `iat` window, a `jti`
 * never seen before, and the server's `nonce`. A well-formed proof without the current nonce answers `use_dpop_nonce`.
 */
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
  expected.seen.add(jti);
  return "ok";
}
