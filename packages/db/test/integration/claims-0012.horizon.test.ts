import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
  withDatabase,
} from "../../src/testing/template.js";
import { seedMembers, WA } from "../support/members-seed.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(seedMembers);
});
afterAll(() => db.drop());
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params?: unknown[]) => admin(async (a) => (await a.query(sql, params)).rows);
const worker = () => db.pool("worker");
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A claim reads below the cluster-wide transaction horizon; wait (without claiming) until a seeded row is under it.
async function belowHorizon(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [row] = await rows(
      "SELECT count(*) FILTER (WHERE xid >= pg_snapshot_xmin(pg_current_snapshot()))::int AS above FROM app.outbox",
    );
    if (row?.above === 0) return;
    await wait(20);
  }
  throw new Error("an older transaction still holds the visibility horizon");
}

const sealedMail = (n: number) =>
  `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
     link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
   VALUES ('${id(n)}', 'claims-${n}@example.test', 'verify_email', 'en', '{}', '\\x01', '\\x02', '\\x03', '\\x04',
     '\\x05', '\\x06', 'k1', 1, 0, '${"d".repeat(64)}')`;

describe("outbox mark identity", () => {
  it("outbox_claim hands out created_at as microsecond text and outbox_mark matches it exactly", async () => {
    await rows("DELETE FROM app.outbox");
    await rows(`INSERT INTO app.outbox (id, type) VALUES ('${id(1)}', 'claims.event')`);
    await belowHorizon();
    const claimed = (await worker().query("SELECT * FROM app.outbox_claim(1)")).rows[0];
    expect(claimed?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const oneMicrosecondOff = String(claimed?.created_at).replace(
      /(\d)Z$/,
      (_m, d) => `${(Number(d) + 1) % 10}Z`,
    );
    const mark = (at: string) =>
      worker().query("SELECT app.outbox_mark($1, $2, 1) AS won", [claimed?.id, at]);
    expect((await mark(oneMicrosecondOff)).rows[0]).toEqual({ won: false });
    expect((await mark(claimed?.created_at)).rows[0]).toEqual({ won: true });
  });
});

describe("mail lease", () => {
  it("email_outbox has a partial index on claimed_until for sending rows", async () => {
    const found = await rows(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = 'email_outbox'
         AND indexdef ~ 'claimed_until' AND indexdef ~ 'sending'`,
    );
    expect(found).toHaveLength(1);
  });

  it("a lapsed mail on its fifth attempt becomes failed with its sealed link NULL instead of being reclaimed", async () => {
    await rows("DELETE FROM app.email_outbox");
    await admin((a) => a.query(sealedMail(1)));
    await rows(
      "UPDATE app.email_outbox SET state = 'sending', attempts = 5, claimed_until = now() - interval '1 second'",
    );
    expect((await worker().query("SELECT * FROM app.email_outbox_claim(10)")).rows).toEqual([]);
    expect(
      await rows("SELECT state, link_ciphertext IS NOT NULL AS sealed, link_digest FROM app.email_outbox"),
    ).toEqual([{ state: "failed", sealed: false, link_digest: "d".repeat(64) }]);
  });
});

describe("purge limits", () => {
  it("a window purge deletes at most 5000 rows per call and counts them", async () => {
    await rows(
      `INSERT INTO app.rate_buckets (scope, key, tokens, refilled_at)
       SELECT 'login_ip', md5(g::text) || md5(g::text), 60, now() - interval '40 days' FROM generate_series(1, 5001) g`,
    );
    const purge = async () =>
      (await worker().query("SELECT removed FROM app.purge_expired('app.rate_buckets')")).rows[0]?.removed;
    expect(await purge()).toBe("5000");
    expect(await purge()).toBe("1");
    expect(await purge()).toBe("0");
  });

  it("purge_expired is the only definer-owned function whose body deletes from an auth table", async () => {
    const found = await rows(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'app'::regnamespace
         AND pg_get_userbyid(proowner) = 'shoutory_definer' AND prosrc ~* 'delete\\s+from\\s+(auth\\.|%)'`,
    );
    expect(found).toEqual([{ proname: "purge_expired" }]);
  });

  it("an unverified account past its window that a membership or an invitation still references is kept", async () => {
    const user = (n: number) =>
      `INSERT INTO auth."user" (id, name, email, email_verified, created_at)
       VALUES ('${id(n)}', 'claims-u${n}', 'claims-u${n}@example.test', false, now() - interval '8 days')`;
    await admin(async (a) => {
      for (const n of [81, 82, 83]) await a.query(user(n));
      await a.query(
        `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
         VALUES ('${WA}', '${id(81)}', (SELECT r.id FROM app.roles r WHERE r.key = 'viewer' AND r.workspace_id IS NULL))`,
      );
      await a.query(
        `INSERT INTO app.invitations (workspace_id, email, role_id, token_hash, expires_at, invited_by)
         VALUES ('${WA}', 'claims-inv@example.test', (SELECT r.id FROM app.roles r WHERE r.key = 'viewer'
           AND r.workspace_id IS NULL), sha256('claims-inv'::bytea), now() + interval '1 day', '${id(82)}')`,
      );
    });
    await worker().query("SELECT app.purge_expired('auth.user_unverified')");
    const left = await rows(`SELECT name FROM auth."user" WHERE name LIKE 'claims-u%' ORDER BY name`);
    expect(left).toEqual([{ name: "claims-u81" }, { name: "claims-u82" }]);
  });
});

describe("audit chain head", () => {
  const today = new Date().toISOString().slice(0, 10);
  const check = async () =>
    (await db.pool("owner").query("SELECT id FROM app.audit_chain_check($1::date)", [today])).rows.map(
      (row) => row.id as string,
    );
  const setHead = (hash: string) =>
    rows("UPDATE app.audit_heads SET head_hash = $1 WHERE day = $2::date", [Buffer.from(hash, "hex"), today]);

  it("compares the day's last hash with its head: a changed head or a removed last row is reported, another day's head is not", async () => {
    for (const n of [1, 2, 3]) {
      await db
        .pool("auth")
        .query("SELECT app.audit_insert_instance('auth.sign_in', 'user', $1, 'req-1', NULL, '{}')", [
          `head-${n}`,
        ]);
    }
    const chain = await rows(
      "SELECT id, tableoid::regclass::text AS leaf, encode(hash, 'hex') AS hash FROM app.audit_logs ORDER BY at, id",
    );
    expect(await check()).toEqual([]);
    await setHead("11".repeat(32));
    expect(await check()).toEqual([chain[2]?.id]);
    await setHead(String(chain[2]?.hash));
    await admin(async (a) => {
      await a.query(`ALTER TABLE ${chain[2]?.leaf} DISABLE TRIGGER audit_logs_immutable`);
      await a.query("DELETE FROM app.audit_logs WHERE id = $1", [chain[2]?.id]);
      await a.query(`ALTER TABLE ${chain[2]?.leaf} ENABLE ALWAYS TRIGGER audit_logs_immutable`);
    });
    expect(await check()).toEqual([chain[1]?.id]);
    await rows("UPDATE app.audit_heads SET day = day - 1");
    expect(await check()).toEqual([]);
  });
});

describe("partition safety", () => {
  const day = (ago: number) => new Date((Math.floor(Date.now() / 864e5) - ago) * 864e5).toISOString();
  // The name ensure_partitions gives the leaf that starts `ahead` days from today (UTC): outbox_YYYYMMDD.
  const dayName = (ahead: number) => day(-ahead).slice(0, 10).replaceAll("-", "");
  const oldLeaf = async (name: string, ago: number, undispatched: boolean) =>
    admin(async (a) => {
      await a.query("SET ROLE shoutory_definer");
      await a.query(
        `CREATE TABLE app.${name} PARTITION OF app.outbox FOR VALUES FROM ('${day(ago + 1)}') TO ('${day(ago)}')`,
      );
      await a.query("RESET ROLE");
      await a.query(
        `INSERT INTO app.outbox (id, created_at, type, payload, dispatched_at)
         VALUES ($1, '${day(ago + 1)}', 'claims.old', '{}', ${undispatched ? "NULL" : "now()"})`,
        [id(ago)],
      );
    });
  const purge = async () =>
    (await worker().query("SELECT removed, skipped FROM app.purge_expired('outbox')")).rows[0];

  it("an old outbox leaf that still holds an undispatched row is kept and named; a dispatched one is dropped", async () => {
    await oldLeaf("outbox_claims_old", 20, true);
    const first = await purge();
    expect(first).toEqual({ removed: "0", skipped: ["app.outbox_claims_old"] });
    expect(await rows("SELECT to_regclass('app.outbox_claims_old')::text AS leaf")).toEqual([
      { leaf: "app.outbox_claims_old" },
    ]);
    await rows("UPDATE app.outbox SET dispatched_at = now() WHERE dispatched_at IS NULL");
    expect(await purge()).toEqual({ removed: "1", skipped: [] });
    expect(await rows("SELECT to_regclass('app.outbox_claims_old') AS leaf")).toEqual([{ leaf: null }]);
  });

  // Another session holding the parent makes each partition statement wait; the run gives up after 2 s (the next
  // daily run retries) instead of queueing behind it and blocking every later query on the table.
  async function whileOutboxLocked(call: string): Promise<void> {
    const holder = new Client({ connectionString: withDatabase(env.adminUrl, db.name) });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE app.outbox IN ACCESS EXCLUSIVE MODE");
      await expect(worker().query(call)).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  }

  it("ensure_partitions gives up with lock_timeout when the outbox is locked and the next run succeeds", async () => {
    await rows(`DROP TABLE app.outbox_${dayName(3)}`);
    await whileOutboxLocked("SELECT app.ensure_partitions()");
    expect((await worker().query("SELECT app.ensure_partitions() AS made")).rows[0]).toEqual({ made: 1 });
  });

  it("the partition branch of purge_expired gives up with lock_timeout when the outbox is locked", async () => {
    await oldLeaf("outbox_claims_gone", 30, false);
    await whileOutboxLocked("SELECT * FROM app.purge_expired('outbox')");
    expect(await purge()).toEqual({ removed: "1", skipped: [] });
  });
});
