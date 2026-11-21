import type { AppPool } from "@shoutory/db/pool";
import { Refusal } from "../errors/refusal.js";

/** The ways a person proves their identity again; the closed list of the `session_step_ups` method column. */
type Method = "password" | "totp";

interface Holder {
  readonly id: string;
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
}

export interface StepUp {
  /**
   * Refuses with `step_up_required`, naming the method, unless the session has a record of the last ten minutes (the
   * window is the definer's). An account with the second factor on counts only a `totp` record: a password alone
   * does not open its sensitive routes.
   */
  require(session: Holder): Promise<void>;
  record(session: { readonly id: string; readonly userId: string }, method: Method): Promise<void>;
}

/** The step-up records of the sessions, through the definers on the `shoutory_auth` pool. */
export function createStepUp(pool: AppPool): StepUp {
  const has = async (session: Holder): Promise<boolean> => {
    // The newest record in the window is the one the definer returns, so a later password check replaces a totp one.
    const found = await pool.query("SELECT method FROM app.step_up_read($1, $2)", [
      session.id,
      session.userId,
    ]);
    const method = found.rows[0]?.method as Method | undefined;
    return method !== undefined && (!session.twoFactorEnabled || method === "totp");
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
