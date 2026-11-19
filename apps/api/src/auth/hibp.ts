import { createHash } from "node:crypto";
import { withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import { Refusal } from "../errors/refusal.js";
import type { Logger } from "../logging/logger.js";

// The fixed host of the k-anonymity range API: only the first five hex digits of the SHA-1 leave the process.
// It joins the operator egress exceptions when `egressFetch` exists; until then the `fetch` is a parameter.
const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** `unavailable`: the service did not answer in time or well; the password is accepted and checked again later. */
type Outcome = "clean" | "breached" | "unavailable";

async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isUnreachable = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** Looks the password up in the range of its hash prefix. Padding lines (count 0) never count as a hit. */
async function checkBreached(fetchRange: typeof fetch, password: string): Promise<Outcome> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  try {
    const response = await fetchRange(`${RANGE_URL}${hash.slice(0, 5)}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    const body = response.ok ? await readCapped(response) : undefined;
    if (body === undefined) return "unavailable";
    // A range answer is padded, so it always holds lines; a body with none is not one (an error page, an empty body).
    const lines = body.split("\n").map((line) => line.trim().split(":"));
    if (!lines.some(([found, count]) => /^[0-9A-F]{35}$/i.test(found ?? "") && /^\d+$/.test(count ?? ""))) {
      return "unavailable";
    }
    const suffix = hash.slice(5);
    return lines.some(([found, count]) => found === suffix && Number(count) > 0) ? "breached" : "clean";
  } catch (error) {
    if (isUnreachable(error)) return "unavailable";
    throw error;
  }
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
  readonly fetch: typeof fetch;
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
    const outcome = await checkBreached(fetchRange, password);
    if (outcome === "unavailable") logger.warn({}, "the breached-password check is unavailable");
    return outcome;
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
