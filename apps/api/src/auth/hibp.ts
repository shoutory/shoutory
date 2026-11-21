import { createHash } from "node:crypto";
import { withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import type { EgressRequest, EgressResponse } from "@shoutory/provider-sdk/egress";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import { Refusal } from "../errors/refusal.js";
import type { Logger } from "../logging/logger.js";

// The fixed host of the k-anonymity range API: only the first five hex digits of the SHA-1 leave the process.
// The request policy of the composition root lists this host, so a redirect to any other host is refused.
export const RANGE_HOST = "api.pwnedpasswords.com";
const RANGE_URL = `https://${RANGE_HOST}/range/`;
const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** `unavailable`: the service did not answer in time or well; the password is accepted and checked again later. */
type Outcome = "clean" | "breached" | "unavailable";

/** Looks the password up in the range of its hash prefix. Padding lines (count 0) never count as a hit. */
async function checkBreached(
  fetchRange: (request: EgressRequest) => Promise<EgressResponse>,
  password: string,
): Promise<Outcome> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const response = await fetchRange({
    url: `${RANGE_URL}${hash.slice(0, 5)}`,
    headers: { "Add-Padding": "true" },
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  if (response.status < 200 || response.status >= 300) return "unavailable";
  // A range answer is padded, so it always holds lines; a body with none is not one (an error page, an empty body).
  const lines = Buffer.from(response.body)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim().split(":"));
  if (!lines.some(([found, count]) => /^[0-9A-F]{35}$/i.test(found ?? "") && /^\d+$/.test(count ?? ""))) {
    return "unavailable";
  }
  const suffix = hash.slice(5);
  return lines.some(([found, count]) => found === suffix && Number(count) > 0) ? "breached" : "clean";
}

export interface PasswordGuard {
  /** Refuses a breached password (400, generic message); answers `unavailable` when the service could not say. */
  screen(password: string): Promise<Outcome>;
  /** After a password was set: `unavailable` marks a re-check at the next sign-in, `clean` clears the mark. */
  settle(userId: string, outcome: Outcome): Promise<void>;
  /** At sign-in, once the password is proven: whether a marked user's password is now found breached. */
  recheckHit(userId: string, password: string): Promise<boolean>;
}

interface GuardDeps {
  /** The egress client with its policy bound (`main.ts`); every refusal or failure it throws is an `EgressError`. */
  readonly fetch: (request: EgressRequest) => Promise<EgressResponse>;
  /** The `shoutory_auth` pool: it may call `password_recheck_set`. */
  readonly pool: AppPool;
  /** The `shoutory_app` pool: a user reads their own mark under template U. */
  readonly appPool: AppPool;
  readonly logger: Logger;
}

export function createPasswordGuard({ fetch: fetchRange, pool, appPool, logger }: GuardDeps): PasswordGuard {
  // The due time is the database's clock, not this process's.
  const mark = (userId: string, due: boolean) =>
    pool.query("SELECT app.password_recheck_set($1, CASE WHEN $2::boolean THEN clock_timestamp() END)", [
      userId,
      due,
    ]);
  const check = async (password: string): Promise<Outcome> => {
    const unavailable = (fields: object) => {
      logger.warn(fields, "the breached-password check is unavailable");
      return "unavailable" as const;
    };
    try {
      const outcome = await checkBreached(fetchRange, password);
      return outcome === "unavailable" ? unavailable({}) : outcome;
    } catch (error) {
      // The class and the host only: an egress error never carries the URL, and the URL holds the hash prefix.
      if (error instanceof EgressError) return unavailable({ egressClass: error.class, host: error.host });
      throw error;
    }
  };
  return {
    async screen(password) {
      const outcome = await check(password);
      if (outcome === "breached") {
        // The reason lets a screen tell this refusal from a wrong current password; it names no list and no source.
        throw new Refusal("validation_failed", "the password is in a breach list", {
          details: { reason: "password_breached" },
        });
      }
      return outcome;
    },
    async settle(userId, outcome) {
      if (outcome !== "breached") await mark(userId, outcome === "unavailable");
    },
    async recheckHit(userId, password) {
      const due = await withTenant(appPool, { principalKind: "user", principalId: userId }, (tx) =>
        tx.query("SELECT password_recheck_at FROM app.user_profiles WHERE user_id = $1", [userId]),
      );
      if (due.rows[0]?.password_recheck_at == null) return false;
      const outcome = await check(password);
      if (outcome === "clean") await mark(userId, false);
      return outcome === "breached";
    },
  };
}
