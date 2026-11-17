import { migrateDatabase } from "@shoutory/db/migrate";

/** `shoutory migrate`: applies every pending migration as the owner role and reports each one through `write`. */
export async function migrateCommand(env: NodeJS.ProcessEnv, write: (line: string) => void): Promise<void> {
  const url = env.SHOUTORY_DATABASE_URL_OWNER;
  if (!url) throw new Error("SHOUTORY_DATABASE_URL_OWNER is not set; migrations run as the owner role");
  const applied = await migrateDatabase(url);
  for (const name of applied) write(`applied ${name}`);
  if (applied.length === 0) write("no pending migrations");
}
