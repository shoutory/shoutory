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

export const flowObjectSchema = z.strictObject({
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});

export const issuerAccepted = (expected: string | undefined, received: string | undefined): boolean =>
  expected === undefined || received === expected;

export const providerErrorText = (raw: string | undefined): string =>
  (raw ?? "").replace(/\p{Cc}/gu, "").slice(0, ERROR_TEXT_LENGTH);
