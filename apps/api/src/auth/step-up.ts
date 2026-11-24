import type { AppPool } from "@shoutory/db/pool";
import { Refusal } from "../errors/refusal.js";

type Method = "password" | "totp" | "backup_code";

interface Holder {
  readonly id: string;
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
}

export interface StepUp {
  /** With the second factor on, only a `totp` or `backup_code` record counts, so a person without the device can still step up. */
  require(session: Holder): Promise<void>;
  record(session: { readonly id: string; readonly userId: string }, method: Method): Promise<void>;
}

export function createStepUp(pool: AppPool): StepUp {
  const has = async (session: Holder): Promise<boolean> => {
    // The newest record in the window is the one the definer returns, so a later password check replaces a totp one.
    const found = await pool.query("SELECT method FROM app.step_up_read($1, $2)", [
      session.id,
      session.userId,
    ]);
    const method = found.rows[0]?.method as Method | undefined;
    return method !== undefined && (!session.twoFactorEnabled || method !== "password");
  };
  return {
    async require(session) {
      if (await has(session)) return;
      const method: Method = session.twoFactorEnabled ? "totp" : "password";
      throw new Refusal("step_up_required", "no authentication in the last ten minutes", {
        details: { method },
      });
    },
    async record(session, method) {
      await pool.query("SELECT app.step_up_record($1, $2, $3)", [session.id, session.userId, method]);
    },
  };
}
