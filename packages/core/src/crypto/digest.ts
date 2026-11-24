import { createHmac } from "node:crypto";
import type { SealedSecret } from "./envelope.js";

// The purpose keeps the uses of one pepper apart.
export function pepperDigest(pepper: SealedSecret, purpose: string, value: string): string {
  return createHmac("sha256", Buffer.from(pepper.expose())).update(`${purpose}:${value}`).digest("hex");
}
