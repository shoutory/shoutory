import type { AppPool } from "@shoutory/db/pool";
import { isUnavailable, Refusal } from "../errors/refusal.js";

/** A partitioned table needs this many leaves that start after now, or a late write finds no partition. */
const MIN_FUTURE_LEAVES = 2;

// Every range-partitioned table of the `app` schema whose key is a timestamptz, from the catalog, so a table added
// later is covered without a list; a hash or list table has no time runway. The lower bound is read from the bound
// expression, which prints its own UTC offset, so the session zone is moot.
const SHORT_TABLES = `
  SELECT parent.relname AS name
  FROM pg_partitioned_table pt
  JOIN pg_class parent ON parent.oid = pt.partrelid
  JOIN pg_namespace ns ON ns.oid = parent.relnamespace AND ns.nspname = 'app'
  JOIN pg_attribute key ON key.attrelid = parent.oid AND key.attnum = pt.partattrs[0]
  LEFT JOIN pg_inherits inh ON inh.inhparent = parent.oid
  LEFT JOIN pg_class leaf ON leaf.oid = inh.inhrelid
  LEFT JOIN LATERAL (
    SELECT substring(pg_get_expr(leaf.relpartbound, leaf.oid) FROM 'FROM \\(''([^'']+)''')::timestamptz AS lower
  ) bound ON true
  WHERE pt.partstrat = 'r' AND key.atttypid = 'timestamptz'::regtype
  GROUP BY parent.relname
  HAVING count(*) FILTER (WHERE bound.lower > now()) < $1`;

export async function assertPartitionRunway(pool: AppPool): Promise<void> {
  let short: string[];
  try {
    short = (await pool.query(SHORT_TABLES, [MIN_FUTURE_LEAVES])).rows.map(
      (row: { name: string }) => row.name,
    );
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    throw new Refusal("service_unavailable", "database unreachable", {
      cause: error,
      details: { cause: "database_unreachable" },
    });
  }
  if (short.length > 0) {
    throw new Refusal("service_unavailable", `too few future partitions: ${short.join(", ")}`, {
      details: { cause: "partitions_short" },
    });
  }
}
