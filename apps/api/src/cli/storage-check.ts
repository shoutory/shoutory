import { parseStorageEnv } from "@shoutory/core/config";
import type { StorageWarning } from "@shoutory/core/storage";
import { checkStorage } from "../storage/check.js";
import { createStorageDriver } from "../storage/driver.js";
import type { CliIo } from "./main.js";

const ABORT_ADVICE =
  "set a bucket lifecycle rule that aborts incomplete multipart uploads after 7 days (see the README)";
const WARNING_TEXT: Record<StorageWarning, string> = {
  no_abort_rule: `the bucket has no rule that aborts incomplete multipart uploads; ${ABORT_ADVICE}`,
  abort_rule_too_long: `the bucket aborts incomplete multipart uploads later than 7 days; ${ABORT_ADVICE}`,
  abort_rule_excludes_uploads: `no abort rule of the bucket covers the keys under ws/; ${ABORT_ADVICE}`,
  abort_rule_unreadable: `the bucket's lifecycle rules cannot be read with these keys or by this server; check by hand that incomplete multipart uploads are aborted after 7 days (see the README)`,
};

/**
 * Probes the configured storage and prints the answer as one JSON line. Any failure, a left probe object included,
 * also names its class on stderr and exits 1; exit 0 means the probe wrote, read back and deleted its object. A warning
 * is advice only: one `warning:` line on stderr each, and the exit code stays 0.
 */
export async function storageCheckCommand(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const driver = createStorageDriver(parseStorageEnv(env));
  const answer = await checkStorage(driver).finally(() => driver.close?.());
  io.stdout(JSON.stringify(answer));
  for (const code of answer.warnings) io.stderr(`warning: ${WARNING_TEXT[code]}`);
  if (answer.failure === null) return 0;
  io.stderr(`the storage check failed: ${answer.failure}`);
  return 1;
}
