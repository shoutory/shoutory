import { Resolver } from "node:dns/promises";

/** The one DNS lookup the mail check makes: the TXT records of a name; a name with none rejects (ENOTFOUND, ENODATA). */
export type TxtResolver = (name: string) => Promise<string[][]>;

const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_TRIES = 2;
const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: LOOKUP_TRIES });
/** The one place the system resolver is used: the CLI and the admin route both look names up through it. */
export const systemResolver: TxtResolver = (name) => resolver.resolveTxt(name);

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

type RecordKind = "SPF" | "DMARC" | "DKIM";
/** `unchecked`: the lookup failed for a reason other than "no such record"; `not_checked`: nothing to look up. */
type RecordState = "present" | "missing" | "unchecked" | "not_checked";

export interface MailRecord {
  readonly kind: RecordKind;
  readonly state: RecordState;
  /** The DNS name looked up; empty when nothing was looked up. */
  readonly name: string;
}

/** The domain of `Name <user@domain>` or `user@domain`, lower-cased; undefined when there is none. */
function domainOf(sender: string | undefined): string | undefined {
  const address = /<([^>]+)>/.exec(sender ?? "")?.[1] ?? sender ?? "";
  const domain = address.split("@")[1]?.trim().toLowerCase();
  return domain ? domain : undefined;
}

/** One record kind: `present` when a TXT record at `name` satisfies `matches`, `missing` when none does. */
async function lookup(
  kind: RecordKind,
  name: string,
  matches: (record: string) => boolean,
  resolve: TxtResolver,
): Promise<MailRecord> {
  try {
    const records = (await resolve(name)).map((chunks) => chunks.join(""));
    return { kind, state: records.some(matches) ? "present" : "missing", name };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && NO_RECORD.has(code)) return { kind, state: "missing", name };
    return { kind, state: "unchecked", name };
  }
}

/**
 * Checks the SPF, DMARC and DKIM records of the sending domain. A missing record is advice, not a failure. With no
 * sender there is no domain and nothing is looked up. The numbers a mail provider asks for (bounce rate, warm-up) are
 * guidance in the self-host guide, never checked here.
 */
export async function checkMailDns(
  sender: { readonly from: string | undefined; readonly dkimSelector: string | undefined },
  resolve: TxtResolver = systemResolver,
): Promise<{ readonly domain: string | undefined; readonly records: MailRecord[] }> {
  const domain = domainOf(sender.from);
  if (!domain) return { domain: undefined, records: [] };
  const { dkimSelector } = sender;
  // The three lookups are independent: together they wait for one lookup's timeout and tries, not three.
  const records = await Promise.all([
    lookup("SPF", domain, (r) => r.toLowerCase().startsWith("v=spf1"), resolve),
    lookup("DMARC", `_dmarc.${domain}`, (r) => r.toUpperCase().startsWith("V=DMARC1"), resolve),
    dkimSelector
      ? lookup("DKIM", `${dkimSelector}._domainkey.${domain}`, (r) => /(^|;)\s*p=/.test(r), resolve)
      : Promise.resolve<MailRecord>({ kind: "DKIM", state: "not_checked", name: "" }),
  ]);
  return { domain, records };
}

/** The line the CLI prints for one record. */
export function describeRecord(record: MailRecord): string {
  if (record.state === "not_checked") return `${record.kind}: not checked (no selector)`;
  const state = record.state === "unchecked" ? "could not be checked" : record.state;
  return `${record.kind}: ${state} (${record.name})`;
}
