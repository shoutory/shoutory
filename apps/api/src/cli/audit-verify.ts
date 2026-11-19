import { createAppPool } from "@shoutory/db/pool";
import type { CliIo } from "./main.js";

const USAGE = "usage: shoutory audit verify [YYYY-MM-DD]";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A date that parses and prints back the same is a real calendar day ("2026-13-40" never is).
function isDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return DAY.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

interface Broken {
  readonly id: string;
  readonly workspace_id: string | null;
}

/**
 * `shoutory audit verify [day]`: the database recomputes the hash chain of one UTC day (today by default) and this
 * exits 0 when it holds, 1 naming the first row that does not, 2 for a bad argument. Image-side: it runs as the owner
 * role, the one role the verifier definer answers.
 */
export async function auditVerifyCommand(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  args: readonly string[],
): Promise<number> {
  const day = args[0] ?? new Date().toISOString().slice(0, 10);
  if (args.length > 1 || !isDay(day)) {
    io.stderr(USAGE);
    return 2;
  }
  const url = env.SHOUTORY_DATABASE_URL_OWNER;
  if (!url) throw new Error("SHOUTORY_DATABASE_URL_OWNER is not set; the chain check runs as the owner role");
  const pool = createAppPool(url, () => io.stderr("database pool error"));
  try {
    const found = await pool.query<Broken>("SELECT id, workspace_id FROM app.audit_chain_check($1::date)", [
      day,
    ]);
    const broken = found.rows[0];
    if (!broken) {
      io.stdout(`audit chain verified for ${day}`);
      return 0;
    }
    const chain = broken.workspace_id === null ? "instance chain" : `workspace ${broken.workspace_id}`;
    io.stderr(`audit chain broken on ${day} at row ${broken.id} (${chain})`);
    return 1;
  } finally {
    await pool.end();
  }
}
