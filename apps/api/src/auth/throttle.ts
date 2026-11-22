import type { SealedSecret } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import type { AppPool } from "@shoutory/db/pool";
import { Refusal } from "../errors/refusal.js";

/** The scopes the sign-in, second-factor and reset routes spend (the capacities live in the `bucket_take` definer). */
type Scope =
  | "login_account"
  | "login_ip"
  | "verification_resend"
  | "link_confirm"
  | "two_factor"
  | "totp_code"
  | "password_reset"
  | "invite"
  | "invite_accept"
  | "unsubscribe"
  | "connect_start"
  | "connect_callback";

// A successful sign-in refunds the whole account bucket: `bucket_take` accepts a cost down to minus the capacity.
const LOGIN_ACCOUNT_CAPACITY = 100;

/** The keyed digest of a mail address as the suppression list stores it: the address is lower-cased first (R323). */
export const emailDigest = (pepper: SealedSecret, address: string): string =>
  pepperDigest(pepper, "email_suppression", address.toLowerCase());

const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 4;

/**
 * What a per-address bucket is keyed on: the whole address for IPv4 and the /64 prefix for IPv6 (a host owns a whole
 * /64, so the full address is no limit at all; the library buckets IPv6 the same way).
 */
export function ipSubject(address: string): string {
  if (!address.includes(":") || address.includes(".")) return address;
  const [head = "", tail] = address.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const gap = tail === undefined ? [] : Array<string>(IPV6_GROUPS - front.length - back.length).fill("0");
  const prefix = [...front, ...gap, ...back].slice(0, IPV6_PREFIX_GROUPS);
  return `${prefix.map((group) => group.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

export interface Throttle {
  /** Spends one token of the bucket; a refusal is a 429 whose `Retry-After` is the bucket's answer. */
  spend(scope: Scope, subject: string): Promise<void>;
  /** `spend` for a client address (the /64 for IPv6). */
  spendIp(scope: Scope, address: string): Promise<void>;
  /** Like `spend`, but answers whether the token was granted instead of refusing. */
  tryAccount(email: string): Promise<boolean>;
  /** Refills the `login_account` bucket of an address, or of a user id (lowercase, as the ids are). */
  refundAccount(subject: string): Promise<void>;
}

interface Taken {
  readonly allowed: boolean;
  readonly retry_after_seconds: number;
}

/** The bucket calls of the sign-in routes; every key is an HMAC digest, never a raw email or address. */
export function createThrottle(pool: AppPool, pepper: SealedSecret): Throttle {
  const take = async (scope: Scope, subject: string, cost: number): Promise<Taken> => {
    const key = pepperDigest(pepper, scope, subject);
    const answer = await pool.query("SELECT * FROM app.bucket_take($1, $2, $3)", [key, scope, cost]);
    return answer.rows[0] as Taken;
  };
  const spend = async (scope: Scope, subject: string): Promise<void> => {
    const taken = await take(scope, subject, 1);
    if (!taken.allowed) {
      throw new Refusal("too_many_requests", `bucket ${scope} is empty`, {
        retryAfterSeconds: taken.retry_after_seconds,
      });
    }
  };
  return {
    spend,
    spendIp: (scope, address) => spend(scope, ipSubject(address)),
    async tryAccount(email) {
      return (await take("login_account", email.toLowerCase(), 1)).allowed;
    },
    async refundAccount(subject) {
      await take("login_account", subject.toLowerCase(), -LOGIN_ACCOUNT_CAPACITY);
    },
  };
}
