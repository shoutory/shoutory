import { parseKeyRing } from "@shoutory/core/config";
import type { KeyProvider } from "@shoutory/core/keys";
import { type AppPool, createAppPool } from "@shoutory/db/pool";
import { sealedKeyIds } from "@shoutory/db/startup";
import type { CliIo } from "../main.js";

export interface Custody {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
}

export function openCustody(env: NodeJS.ProcessEnv, io: CliIo): Custody {
  const url = env.SHOUTORY_DATABASE_URL_WORKER;
  if (!url)
    throw new Error("SHOUTORY_DATABASE_URL_WORKER is not set; the secrets commands run as the worker role");
  const keys = parseKeyRing(env);
  return { keys, pool: createAppPool(url, () => io.stderr("database pool error")) };
}

/**
 * `shoutory secrets check`: exits 0 only when every key id that sealed rows hold is loaded and is the active one.
 * Otherwise it names the key ids, those with no loaded key apart from those that are loaded but not active.
 */
export async function checkCommand(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { pool, keys } = openCustody(env, io);
  try {
    const held = await sealedKeyIds(pool);
    const missing = held.filter((id) => !keys.has(id));
    const retired = held.filter((id) => keys.has(id) && id !== keys.activeKeyId());
    if (missing.length > 0) io.stderr(`not loaded: ${missing.join(", ")}`);
    if (retired.length > 0) io.stderr(`not active: ${retired.join(", ")}`);
    if (missing.length + retired.length > 0) return 1;
    io.stdout(`ok: every sealed row is under the active key ${keys.activeKeyId()}`);
    return 0;
  } finally {
    await pool.end();
  }
}
