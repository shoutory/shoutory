import { checkMailDns, describeRecord, systemResolver, type TxtResolver } from "../mail/dns-check.js";
import type { CliIo } from "./main.js";

export type { TxtResolver } from "../mail/dns-check.js";

/**
 * Checks the SPF, DMARC and DKIM records of the sending domain. A missing record is advice, not a failure:
 * the command exits 0, and exits 1 only when it has no sender to take the domain from. The numbers a mail provider
 * asks for (bounce rate, warm-up, DMARC ramp) are guidance in the self-host guide, never checked here.
 */
export async function mailCheckCommand(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  resolve: TxtResolver = systemResolver,
): Promise<number> {
  const sender = { from: env.SHOUTORY_MAIL_FROM, dkimSelector: env.SHOUTORY_MAIL_DKIM_SELECTOR };
  const { domain, records } = await checkMailDns(sender, resolve);
  if (!domain) {
    io.stderr("SHOUTORY_MAIL_FROM must be set to an address: the check reads the sending domain from it");
    return 1;
  }
  for (const record of records) io.stdout(describeRecord(record));
  return 0;
}
