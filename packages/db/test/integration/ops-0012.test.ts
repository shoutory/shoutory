import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params?: unknown[]) => admin(async (a) => (await a.query(sql, params)).rows);
const pool = (role: Parameters<TestDatabase["pool"]>[0]): Pool => db.pool(role);

const FUTURE_LEAVES = `
  SELECT count(*)::int AS n,
         (SELECT partdefid FROM pg_partitioned_table WHERE partrelid = $1::regclass) AS default_leaf
  FROM pg_inherits i JOIN pg_class leaf ON leaf.oid = i.inhrelid
  WHERE i.inhparent = $1::regclass
    AND substring(pg_get_expr(leaf.relpartbound, leaf.oid) FROM 'FROM \\(''([^'']+)''')::timestamptz > now()`;

describe("ensure_partitions", () => {
  it.each(["app.outbox", "app.audit_logs"])(
    "%s regains three future leaves, no DEFAULT partition, and each leaf keeps row security",
    async (parent) => {
      await admin(async (a) => {
        const future = await a.query(
          `SELECT leaf.oid::regclass::text AS name FROM pg_inherits i JOIN pg_class leaf ON leaf.oid = i.inhrelid
           WHERE i.inhparent = $1::regclass AND substring(pg_get_expr(leaf.relpartbound, leaf.oid)
             FROM 'FROM \\(''([^'']+)''')::timestamptz > now()`,
          [parent],
        );
        for (const row of future.rows) await a.query(`DROP TABLE ${row.name}`);
      });
      expect((await rows(FUTURE_LEAVES, [parent]))[0]).toMatchObject({ n: 0 });
      await pool("worker").query("SELECT app.ensure_partitions()");
      expect((await rows(FUTURE_LEAVES, [parent]))[0]).toEqual({ n: 3, default_leaf: 0 });
      const leaves = await rows(
        `SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass
           AND substring(pg_get_expr(c.relpartbound, c.oid) FROM 'FROM \\(''([^'']+)''')::timestamptz > now()`,
        [parent],
      );
      expect(leaves).toEqual([{ secured: true }, { secured: true }, { secured: true }]);
    },
  );

  it("an audit leaf it creates refuses UPDATE, DELETE and TRUNCATE even with replication triggers off", async () => {
    const triggers = await rows(
      `SELECT t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_inherits i ON i.inhrelid = t.tgrelid
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'app.audit_logs'::regclass AND NOT t.tgisinternal
         AND substring(pg_get_expr(c.relpartbound, c.oid) FROM 'FROM \\(''([^'']+)''')::timestamptz > now()
       ORDER BY t.tgname`,
    );
    expect(new Set(triggers.map((t) => `${t.tgname}:${t.tgenabled}`))).toEqual(
      new Set(["audit_logs_immutable:A", "audit_logs_no_truncate:A"]),
    );
  });
});

const RETAINED = [
  ["app.audit_logs", "audit_logs"],
  ["app.outbox", "outbox"],
  ["app.email_outbox", "email_outbox"],
  ["auth.session", "auth.session"],
  ["auth.verification", "auth.verification"],
  ["app.session_step_ups", "app.session_step_ups"],
  ["app.invitations", "app.invitations"],
  ["app.media_uploads", "app.media_uploads"],
  ["app.idempotency_keys", "app.idempotency_keys"],
  ["app.post_versions", "app.post_versions_autosave"],
  ["app.operation_attempts", "app.operation_attempts"],
  ["app.usage_reservations", "app.usage_reservations"],
  ["app.provider_quota_ledger", "app.provider_quota_ledger"],
  ["app.oauth_flows", "app.oauth_flows"],
  ["app.provider_instance_apps", "app.provider_instance_apps"],
  ["app.connect_challenges", "app.connect_challenges"],
  ["app.rate_buckets", "app.rate_buckets"],
  ["app.worker_heartbeats", "app.worker_heartbeats"],
  ["auth.user", "auth.user_unverified"],
] as const;

describe("a row dated past the last leaf", () => {
  it("an audit insert dated past the last leaf is refused and no leaf catches it", async () => {
    const insert = admin((a) =>
      a.query(
        `INSERT INTO app.audit_logs (at, actor_kind, actor_ref, action, resource_kind, resource_id, prev_hash, hash)
         VALUES (now() + interval '20 years', 'system', 'probe', 'probe.done', 'probe', 'beyond', $1, $1)`,
        [Buffer.alloc(32)],
      ),
    );
    await expect(insert).rejects.toMatchObject({ code: "23514" });
    expect(
      await rows(
        "SELECT partdefid::int AS d FROM pg_partitioned_table WHERE partrelid = 'app.audit_logs'::regclass",
      ),
    ).toEqual([{ d: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.audit_logs WHERE resource_id = 'beyond'")).toEqual([
      { n: 0 },
    ]);
  });
});

describe("audit chain heads and their leaf", () => {
  it("purge_expired drops an old audit leaf and deletes exactly the heads of its days, workspace and instance chains, keeping newer heads", async () => {
    const year = new Date().getUTCFullYear() - 3;
    const workspace = randomUUID();
    await admin(async (a) => {
      await a.query("SET ROLE shoutory_definer");
      await a.query(
        `CREATE TABLE app.audit_logs_old_month PARTITION OF app.audit_logs
           FOR VALUES FROM ('${year}-03-01T00:00:00Z') TO ('${year}-04-01T00:00:00Z')`,
      );
      await a.query("RESET ROLE");
      for (const day of [
        `${year}-02-28`,
        `${year}-03-01`,
        `${year}-03-15`,
        `${year}-03-31`,
        `${year}-04-01`,
      ]) {
        await a.query(
          "INSERT INTO app.audit_heads (workspace_id, day, head_hash) VALUES ($1, $2, $4), (NULL, $2, $4), ($3, $2, $4)",
          [workspace, day, randomUUID(), Buffer.alloc(32)],
        );
      }
    });
    // A session zone west of UTC would read the leaf's bounds a day early if the function used it.
    const session = await pool("worker").connect();
    try {
      await session.query("SET timezone = 'America/Los_Angeles'");
      await session.query("SELECT app.purge_expired('audit_logs')");
    } finally {
      await session.query("RESET timezone");
      session.release();
    }
    expect(await rows("SELECT to_regclass('app.audit_logs_old_month') AS leaf")).toEqual([{ leaf: null }]);
    const left = await rows(
      "SELECT workspace_id IS NULL AS instance, day::text AS day FROM app.audit_heads WHERE day < '2999-01-01' ORDER BY instance, day",
    );
    const days = left.filter((row) => row.day.startsWith(String(year)));
    expect(days.map((row) => `${row.instance ? "instance" : "workspace"} ${row.day}`)).toEqual([
      `workspace ${year}-02-28`,
      `workspace ${year}-02-28`,
      `workspace ${year}-04-01`,
      `workspace ${year}-04-01`,
      `instance ${year}-02-28`,
      `instance ${year}-04-01`,
    ]);
  });
});

describe("retention classes", () => {
  it.each(RETAINED)("%s has the class %s", async (table, klass) => {
    const found = await rows(
      "SELECT table_name FROM app.retention_classes WHERE class = $1 AND to_regclass(table_name) IS NOT NULL",
      [klass],
    );
    expect(found).toEqual([{ table_name: table }]);
  });

  it("the registry holds no class beyond the retained ones", async () => {
    const found = await rows("SELECT class FROM app.retention_classes ORDER BY class");
    expect(found.map((row) => row.class)).toEqual(RETAINED.map(([, klass]) => klass).sort());
  });

  it("an unknown class is refused", async () => {
    await expect(pool("worker").query("SELECT app.purge_expired('no.such_class')")).rejects.toMatchObject({
      code: "22023",
    });
  });
});

describe("worker liveness and lag", () => {
  const status = async () => (await pool("app").query("SELECT * FROM app.worker_status()")).rows;

  it("a beat creates the worker and the next keeps its start; 90 s of silence shows as stale", async () => {
    await pool("worker").query("SELECT app.worker_heartbeat('floor-worker-1', 'worker')");
    const [first] = await rows("SELECT started_at, seen_at FROM app.worker_heartbeats");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool("worker").query("SELECT app.worker_heartbeat('floor-worker-1', 'worker')");
    const [second] = await rows("SELECT started_at, seen_at FROM app.worker_heartbeats");
    expect(second?.started_at).toEqual(first?.started_at);
    expect(second?.seen_at.getTime()).toBeGreaterThan(first?.seen_at.getTime());
    expect((await status())[0]).toMatchObject({ worker_id: "floor-worker-1", stale: false });
    await rows("UPDATE app.worker_heartbeats SET seen_at = now() - interval '89 seconds'");
    expect((await status())[0]).toMatchObject({ stale: false });
    await rows("UPDATE app.worker_heartbeats SET seen_at = now() - interval '91 seconds'");
    expect((await status())[0]).toMatchObject({ stale: true });
  });

  // A video's row is held for up to 30 minutes by its own relay, so it never counts toward readiness.
  it("the outbox lag is the age of the oldest undispatched event other than an upload, 0 with none", async () => {
    const lag = async () =>
      (await pool("app").query("SELECT app.outbox_lag() AS lag")).rows[0]?.lag as number;
    await rows("DELETE FROM app.outbox");
    // Leaves start at today, so in the first minutes after midnight UTC a back-dated row needs yesterday's leaf.
    await rows(`DO $$
      DECLARE
        day timestamp := date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 day';
        leaf text := 'outbox_' || to_char(day, 'YYYYMMDD');
      BEGIN
        IF to_regclass('app.' || leaf) IS NULL THEN
          EXECUTE format('CREATE TABLE app.%I PARTITION OF app.outbox FOR VALUES FROM (%L) TO (%L)', leaf,
            (day AT TIME ZONE 'UTC')::text, ((day + interval '1 day') AT TIME ZONE 'UTC')::text);
        END IF;
      END $$`);
    await rows(
      `INSERT INTO app.outbox (id, created_at, type)
       VALUES (gen_random_uuid(), now() - interval '900 seconds', 'media.uploaded')`,
    );
    expect(await lag()).toBe(0);
    await rows(
      `INSERT INTO app.outbox (id, created_at, type) VALUES (gen_random_uuid(), now() - interval '100 seconds', 'test.lag'),
         (gen_random_uuid(), now() - interval '10 seconds', 'test.lag')`,
    );
    expect(await lag()).toBeGreaterThanOrEqual(100);
    expect(await lag()).toBeLessThan(110);
  });

  it("the job lag is the age of the oldest due job, and says not installed before the library is", async () => {
    const lag = async () => (await pool("app").query("SELECT * FROM app.job_lag()")).rows[0];
    // The api's test setup installs the queue library into the template; this test starts without it.
    await admin((a) => a.query("DROP SCHEMA IF EXISTS pgboss CASCADE"));
    expect(await lag()).toEqual({ installed: false, lag_seconds: null });
    await admin(async (a) => {
      await a.query(
        `CREATE SCHEMA pgboss; CREATE TABLE pgboss.job (name text, state text, start_after timestamptz);
         GRANT USAGE ON SCHEMA pgboss TO shoutory_definer; GRANT SELECT ON pgboss.job TO shoutory_definer`,
      );
      await a.query(
        `INSERT INTO pgboss.job VALUES ('q', 'created', now() - interval '50 seconds'),
           ('q', 'retry', now() - interval '20 seconds'), ('q', 'created', now() + interval '1 hour'),
           ('q', 'active', now() - interval '500 seconds')`,
      );
    });
    const found = await lag();
    expect(found.installed).toBe(true);
    expect(found.lag_seconds).toBeGreaterThanOrEqual(50);
    expect(found.lag_seconds).toBeLessThan(60);
  });
});

describe("email suppressions and the unsubscribe throttle", () => {
  const digest = "a".repeat(64);

  it("a second add of one digest changes nothing; a bad reason or digest is refused", async () => {
    const add = (value: string, reason: string, role: "app" | "worker" = "worker") =>
      pool(role).query("SELECT app.email_suppression_add($1, $2)", [value, reason]);
    await add(digest, "unsubscribe", "app");
    await add(digest, "complaint");
    expect(await rows("SELECT email_digest, reason FROM app.email_suppressions")).toEqual([
      { email_digest: digest, reason: "unsubscribe" },
    ]);
    await expect(add(digest, "spam")).rejects.toMatchObject({ code: "23514" });
    await expect(add("not-a-digest", "unsubscribe")).rejects.toMatchObject({ code: "23514" });
  });

  it("the unsubscribe scope allows 20 in a window and refuses the 21st", async () => {
    const key = randomUUID().replaceAll("-", "").repeat(2);
    const take = async () =>
      (await pool("app").query("SELECT allowed FROM app.bucket_take($1, 'unsubscribe', 1)", [key])).rows[0]
        ?.allowed as boolean;
    const answers: boolean[] = [];
    for (let n = 0; n < 21; n += 1) answers.push(await take());
    expect(answers.filter(Boolean)).toHaveLength(20);
    expect(answers[20]).toBe(false);
  });
});
