import { createHmac } from "node:crypto";
import type { SealedSecret } from "./envelope.js";

/**
 * The one keyed digest of the application: HMAC-SHA256 over `purpose:value` under the pepper, in lower-case hex. Bucket
 * keys, stored address digests and refresh-token digests all come from it; the purpose keeps the uses of the pepper
 * apart.
 */
export function pepperDigest(pepper: SealedSecret, purpose: string, value: string): string {
  return createHmac("sha256", Buffer.from(pepper.expose())).update(`${purpose}:${value}`).digest("hex");
}
