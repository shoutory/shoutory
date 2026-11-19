import { createHmac, timingSafeEqual } from "node:crypto";
import type { SealedSecret } from "@shoutory/core/crypto";
import type { AppPool } from "@shoutory/db/pool";
import { z } from "zod";
import type { AuthService } from "../auth/auth.js";
import { emailDigest } from "../auth/throttle.js";
import { Refusal } from "../errors/refusal.js";
import { type App, defineRoute } from "./define-route.js";

// The one-click unsubscribe token (R306, R323): base64url of the 32-byte address digest, a dot, and base64url of an
// HMAC over that digest under the pepper. It is stateless; the HMAC proves the mail sender minted it.
const mac = (pepper: SealedSecret, digest: string): string =>
  createHmac("sha256", Buffer.from(pepper.expose())).update(`unsubscribe:${digest}`).digest("base64url");

/** The token of one recipient, for the List-Unsubscribe header of a marketing mail. */
export function unsubscribeToken(pepper: SealedSecret, address: string): string {
  const digest = emailDigest(pepper, address);
  return `${Buffer.from(digest, "hex").toString("base64url")}.${mac(pepper, digest)}`;
}

// 32 bytes are 43 base64url characters.
const TOKEN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

/** The address digest a token carries, or undefined when the token is malformed or its HMAC does not match. */
function digestOfToken(pepper: SealedSecret, token: string): string | undefined {
  const found = TOKEN.exec(token);
  if (!found) return undefined;
  const digest = Buffer.from(found[1] ?? "", "base64url").toString("hex");
  const given = Buffer.from(found[2] ?? "", "base64url");
  const expected = Buffer.from(mac(pepper, digest), "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected) ? digest : undefined;
}

// A bad token is a 404, not a validation error: the path says nothing a client could correct.
const params = z.strictObject({ token: z.string().max(256) });

/**
 * RFC 8058 one-click unsubscribe: no login, no cookie, no web-client header; the token in the path is the credential
 * (R321). A valid token adds the address digest to the suppression list; a repeat changes nothing. Nothing reads the
 * list yet: the definer that lets the sender skip a suppressed marketing recipient comes with the first marketing
 * template (R325), and transactional mail never reads it. Mailbox providers post one-click requests from shared
 * source addresses (RFC 8058 3.2), so a valid token costs no bucket token: only the pepper holder mints one and the
 * write is idempotent. A bad token spends the client's bucket, which limits guessing (R325).
 */
export function registerUnsubscribe(app: App, auth: AuthService, pool: AppPool): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/unsubscribe/{token}",
    policy: "public",
    access: "none",
    csrf: "token",
    params,
    handler: async ({ params: { token }, clientAddress }) => {
      const digest = digestOfToken(auth.mail.pepper, token);
      if (!digest) {
        await auth.throttle.spendIp("unsubscribe", clientAddress);
        throw new Refusal("not_found", "no such unsubscribe link");
      }
      await pool.query("SELECT app.email_suppression_add($1, 'unsubscribe')", [digest]);
      return null;
    },
  });
}
