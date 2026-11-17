import type { Pool, PoolClient } from "pg";

// The one place that calls an advisory lock function; a contract test refuses a call anywhere else. A lock is
// keyed by a fixed class id plus a hash of the key, and a code path takes classes in the order listed here.
const CLASS_IDS = { migrate: 1, channel: 2 } as const;
export type LockClass = keyof typeof CLASS_IDS;

/**
 * The migrate class is instance-wide and held at session level on its own connection, so a migration file that
 * must run outside a transaction stays covered; the callback gets that connection.
 */
export function withAdvisoryLock<T>(
  pool: Pool,
  lockClass: "migrate",
  run: (client: PoolClient) => Promise<T>,
): Promise<T>;
/** Every other class is transaction-scoped: `tx` must already be inside a transaction, which releases the lock. */
export function withAdvisoryLock<T>(
  tx: PoolClient,
  lockClass: "channel",
  run: () => Promise<T>,
  key: string,
): Promise<T>;
export function withAdvisoryLock<T>(
  db: Pool | PoolClient,
  lockClass: LockClass,
  run: (client: PoolClient) => Promise<T>,
  key = "",
): Promise<T> {
  const id = CLASS_IDS[lockClass];
  return lockClass === "migrate"
    ? withSessionLock(db as Pool, id, key, run)
    : withTransactionLock(db as PoolClient, id, key, run);
}

async function withSessionLock<T>(
  pool: Pool,
  id: number,
  key: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // A connection in doubt (a failed lock or unlock call) is destroyed: closing the session frees any lock it holds.
  let destroy = false;
  const unlock = () => client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [id, key]);
  try {
    try {
      await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [id, key]);
    } catch (error) {
      destroy = true;
      throw error;
    }
    let result: T;
    try {
      result = await run(client);
    } catch (error) {
      // The callback's error is the one the caller needs; a failed unlock only costs the connection.
      await unlock().catch(() => {
        destroy = true;
      });
      throw error;
    }
    await unlock().catch((error: unknown) => {
      destroy = true;
      throw error;
    });
    return result;
  } finally {
    client.release(destroy);
  }
}

async function withTransactionLock<T>(
  tx: PoolClient,
  id: number,
  key: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [id, key]);
  // Outside a transaction the lock is already gone; refuse instead of running unprotected.
  const held = await tx.query(
    `SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
       AND objsubid = 2 AND classid = $1 AND objid = hashtext($2)::oid`,
    [id, key],
  );
  if (held.rowCount === 0) throw new Error("withAdvisoryLock needs an open transaction for this lock class");
  return run(tx);
}
