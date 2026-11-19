import { Resolver } from "node:dns/promises";
import type { CliIo } from "./main.js";

/** The one DNS lookup the mail check makes: the TXT records of a name; a name with none rejects (ENOTFOUND, ENODATA). */
export type TxtResolver = (name: string) => Promise<string[][]>;

const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_TRIES = 2;
const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: LOOKUP_TRIES });
const systemResolver: TxtResolver = (name) => resolver.resolveTxt(name);

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

/** The domain of `Name <user@domain>` or `user@domain`, lower-cased; undefined when there is none. */
function domainOf(sender: string | undefined): string | undefined {
  const address = /<([^>]+)>/.exec(sender ?? "")?.[1] ?? sender ?? "";
  const domain = address.split("@")[1]?.trim().toLowerCase();
  return domain ? domain : undefined;
}

/** One record kind: `present` when a TXT record at `name` satisfies `matches`, `missing` when none does. */
async function lookup(
  label: string,
  name: string,
  matches: (record: string) => boolean,
  resolve: TxtResolver,
): Promise<string> {
  try {
    const records = (await resolve(name)).map((chunks) => chunks.join(""));
    return `${label}: ${records.some(matches) ? "present" : "missing"} (${name})`;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && NO_RECORD.has(code)) return `${label}: missing (${name})`;
    return `${label}: could not be checked (${name})`;
  }
}

/**
 * Checks the SPF, DMARC and DKIM records of the sending domain (V-268). A missing record is advice, not a failure:
 * the command exits 0, and exits 1 only when it has no sender to take the domain from. The numbers a mail provider
 * asks for (bounce rate, warm-up, DMARC ramp) are guidance in the self-host guide, never checked here.
 */
export async function mailCheckCommand(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  resolve: TxtResolver = systemResolver,
): Promise<number> {
  const domain = domainOf(env.SHOUTORY_MAIL_FROM);
  if (!domain) {
    io.stderr("SHOUTORY_MAIL_FROM must be set to an address: the check reads the sending domain from it");
    return 1;
  }
  const selector = env.SHOUTORY_MAIL_DKIM_SELECTOR;
  io.stdout(await lookup("SPF", domain, (r) => r.toLowerCase().startsWith("v=spf1"), resolve));
  io.stdout(
    await lookup("DMARC", `_dmarc.${domain}`, (r) => r.toUpperCase().startsWith("V=DMARC1"), resolve),
  );
  io.stdout(
    selector
      ? await lookup("DKIM", `${selector}._domainkey.${domain}`, (r) => /(^|;)\s*p=/.test(r), resolve)
      : "DKIM: not checked (no selector)",
  );
  return 0;
}
