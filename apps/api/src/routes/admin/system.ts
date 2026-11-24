import { readFileSync } from "node:fs";
import type { AppPool } from "@shoutory/db/pool";
import { z } from "zod";
import { migrationStatus } from "../../health/migrations.js";
import { type App, defineRoute } from "../define-route.js";
import { asAdmin } from "./admin.js";

const rootPackage = z.object({ version: z.string().min(1) });

// Null when the file is missing or has no version, so the screen says "not available" instead of a guess.
function readVersion(): string | null {
  try {
    const text = readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8");
    const parsed = rootPackage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.version : null;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function registerSystem(app: App, pool: AppPool, channel: string): void {
  const version = readVersion();
  defineRoute(app, {
    method: "get",
    path: "/api/v1/admin/system",
    policy: "session",
    access: "user",
    handler: async ({ inUserTx }) => {
      await asAdmin(inUserTx, async () => undefined);
      return { version, channel, migrations: await migrationStatus(pool) };
    },
  });
}
