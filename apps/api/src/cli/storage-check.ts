import { parseStorageEnv } from "@shoutory/core/config";
import { checkStorage } from "../storage/check.js";
import { createStorageDriver } from "../storage/driver.js";
import type { CliIo } from "./main.js";

/**
 * Probes the configured storage and prints the answer as one JSON line. Any failure, a left probe object included,
 * also names its class on stderr and exits 1; exit 0 means the probe wrote, read back and deleted its object.
 */
export async function storageCheckCommand(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const driver = createStorageDriver(parseStorageEnv(env));
  const answer = await checkStorage(driver).finally(() => driver.close?.());
  io.stdout(JSON.stringify(answer));
  if (answer.failure === null) return 0;
  io.stderr(`the storage check failed: ${answer.failure}`);
  return 1;
}
