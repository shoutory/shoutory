import type { Context } from "hono";
import { Refusal } from "../errors/refusal.js";

// 1 to 255 visible ASCII characters (no space). The key is checked and nothing more: the store and the replay of an
// answer come with the API keys.
const KEY = /^[\x21-\x7e]{1,255}$/;

export function requireIdempotencyKey(c: Context): string {
  const key = c.req.header("idempotency-key");
  if (key === undefined || !KEY.test(key)) {
    throw new Refusal(
      "validation_failed",
      "the request needs an Idempotency-Key of 1 to 255 printable characters",
      {
        details: { reason: "idempotency_key_required" },
      },
    );
  }
  return key;
}
