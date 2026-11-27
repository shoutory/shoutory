import type { Fixture } from "../integration/auth/harness.js";

type Admin = Fixture["admin"];

// A sleep between polls; the test's own timeout is the outer bound.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitsOnALock(admin: Admin, settled: () => boolean, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !settled()) {
    const waiting = await admin((client) =>
      client.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'`,
      ),
    );
    if (waiting.rowCount) return;
    await pause(25);
  }
}

export interface HeldProbe {
  /** One entry per probe statement: true when no lock was held on the row, false when the writer already holds it. */
  readonly free: boolean[];
  readonly response: Response;
}

/**
 * Takes `hold` (a locking statement) in an open transaction, starts the writer, waits until it is blocked on a lock,
 * then tries each probe (`SELECT ... FOR UPDATE NOWAIT`) from a third connection. A probe that finds its row locked
 * means the writer took that lock before it reached the held one. It fails when the writer never waits.
 */
export async function probeWhileHeld(
  admin: Admin,
  hold: { sql: string; params: unknown[] },
  write: () => Promise<Response>,
  probes: { sql: string; params: unknown[] }[],
  waitMs = 8000,
): Promise<HeldProbe> {
  return admin(async (holder) => {
    await holder.query("BEGIN");
    try {
      await holder.query(hold.sql, hold.params);
      let finished: Response | undefined;
      const pending = write().then((answer) => {
        finished = answer;
        return answer;
      });
      await waitsOnALock(admin, () => finished !== undefined, waitMs);
      if (finished !== undefined) {
        throw new Error(`the writer finished with ${finished.status} without waiting on the held lock`);
      }
      const free: boolean[] = [];
      for (const probe of probes) {
        free.push(
          await admin(async (client) => {
            await client.query("BEGIN");
            try {
              await client.query(probe.sql, probe.params);
              return true;
            } catch (error) {
              if ((error as { code?: string }).code === "55P03") return false;
              throw error;
            } finally {
              await client.query("ROLLBACK");
            }
          }),
        );
      }
      await holder.query("COMMIT");
      return { free, response: await pending };
    } finally {
      await holder.query("ROLLBACK");
    }
  });
}

export const rowLock = (table: string, id: string) => ({
  sql: `SELECT 1 FROM app.${table} WHERE id = $1 FOR UPDATE NOWAIT`,
  params: [id],
});
