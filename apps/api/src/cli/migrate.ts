import { migrateDatabase } from "@shoutory/db/migrate";
import { builtInManifests } from "@shoutory/provider-registry";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { installJobs } from "../jobs/install.js";

/** `shoutory migrate`: applies every pending migration as the owner role, then installs the job queues. */
export async function migrateCommand(env: NodeJS.ProcessEnv, write: (line: string) => void): Promise<void> {
  const url = env.SHOUTORY_DATABASE_URL_OWNER;
  if (!url) throw new Error("SHOUTORY_DATABASE_URL_OWNER is not set; migrations run as the owner role");
  const applied = await migrateDatabase(url);
  for (const name of applied) write(`applied ${name}`);
  if (applied.length === 0) write("no pending migrations");
  await installJobs(url, createRegistry(builtInManifests).allQueueNames());
}
