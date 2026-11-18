import type { AppPool } from "@shoutory/db/pool";

/** The ways a person proves their identity again; the closed list of the `session_step_ups` method column. */
type Method = "password" | "totp";

export interface StepUp {
  /** Whether the session has a record of the last ten minutes (the window is the definer's). */
  has(session: { readonly id: string; readonly userId: string }): Promise<boolean>;
  record(session: { readonly id: string; readonly userId: string }, method: Method): Promise<void>;
}

/** The step-up records of the sessions, through the definers on the `shoutory_auth` pool. */
export function createStepUp(pool: AppPool): StepUp {
  return {
    async has(session) {
      const found = await pool.query("SELECT method FROM app.step_up_read($1, $2)", [
        session.id,
        session.userId,
      ]);
      return found.rows.length > 0;
    },
    async record(session, method) {
      await pool.query("SELECT app.step_up_record($1, $2, $3)", [session.id, session.userId, method]);
    },
  };
}
