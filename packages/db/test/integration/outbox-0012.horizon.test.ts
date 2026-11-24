import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withTenant } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
  withDatabase,
} from "../../src/testing/template.js";
import { asUser, EMAIL, type Planted, plantInvitation, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(seedMembers);
});
afterAll(() => db.drop());
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params?: unknown[]) => admin(async (a) => (await a.query(sql, params)).rows);
const pool = (role: Parameters<TestDatabase["pool"]>[0]): Pool => db.pool(role);
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("0012 tables are reachable only through definers", () => {
  it.each(["outbox", "worker_heartbeats", "email_suppressions", "retention_classes"])(
    "no runtime role holds a privilege on app.%s or a leaf of it, and it is FORCE RLS",
    async (table) => {
      const found = await rows(
        `SELECT c.oid::regclass::text AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM unnest(ARRAY['shoutory_app','shoutory_worker','shoutory_auth','shoutory_readonly']) r,
                   unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                 WHERE has_table_privilege(r, c.oid, p)) AS granted
         FROM pg_class c WHERE c.oid = ('app.' || $1)::regclass
            OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = ('app.' || $1)::regclass)`,
        [table],
      );
      expect(found.length).toBeGreaterThan(0);
      for (const row of found) expect(row).toMatchObject({ rls: true, forced: true, granted: 0 });
    },
  );
});

const resetSignup = (a: Client) =>
  a.query("DELETE FROM app.instance_admins; DELETE FROM app.instance_settings; DELETE FROM app.invitations");
const addAdmin = (a: Client) => a.query("INSERT INTO app.instance_admins (user_id) VALUES ($1)", [U.owner]);
const setting = (a: Client) =>
  a.query("INSERT INTO app.instance_settings (key, value) VALUES ('signup_enabled', 'true')");
const invite = (extra: Partial<Planted>) => (a: Client) =>
  plantInvitation(a, { token: randomUUID(), ...extra });
const closedWithAdmin = async (a: Client, plant?: (a: Client) => Promise<unknown>) => {
  await addAdmin(a);
  await plant?.(a);
};

describe("sign-up gate", () => {
  it.each<[string, (a: Client) => Promise<unknown>, string, boolean]>([
    ["no instance admin exists", async () => undefined, EMAIL.other, true],
    ["the setting is true", (a) => closedWithAdmin(a, setting), EMAIL.other, true],
    [
      "a pending unexpired invitation is addressed to the email",
      (a) => closedWithAdmin(a, invite({})),
      EMAIL.invitee,
      true,
    ],
    [
      "the address differs from the invitation's only in case",
      (a) => closedWithAdmin(a, invite({})),
      EMAIL.invitee.toUpperCase(),
      true,
    ],
    ["an admin exists and nothing else opens it", (a) => closedWithAdmin(a), EMAIL.other, false],
    ["the invitation was used", (a) => closedWithAdmin(a, invite({ used: true })), EMAIL.invitee, false],
    [
      "the invitation was revoked",
      (a) => closedWithAdmin(a, invite({ revoked: true })),
      EMAIL.invitee,
      false,
    ],
    [
      "the invitation expired",
      (a) => closedWithAdmin(a, invite({ expires: "-1 day" })),
      EMAIL.invitee,
      false,
    ],
    ["the invitation is for another address", (a) => closedWithAdmin(a, invite({})), EMAIL.other, false],
  ])("signup_gate: %s", async (_name, arrange, email, open) => {
    await admin(async (a) => {
      await resetSignup(a);
      await arrange(a);
    });
    const gate = await pool("auth").query("SELECT app.signup_gate($1) AS open", [email]);
    expect(gate.rows[0]).toEqual({ open });
  });

  it("signup_open answers the address-free conditions and instance_settings_read refuses a non-admin", async () => {
    await admin(async (a) => {
      await resetSignup(a);
      await addAdmin(a);
    });
    expect((await pool("app").query("SELECT app.signup_open() AS open")).rows[0]).toEqual({ open: false });
    const read = (user: string) =>
      withTenant(pool("app"), asUser(user), (tx) => tx.query("SELECT * FROM app.instance_settings_read()"));
    await expect(read(U.viewer)).rejects.toMatchObject({ code: "42501" });
    await expect(read(U.owner)).resolves.toBeDefined();
  });
});

describe("audit_chain_check", () => {
  const today = new Date().toISOString().slice(0, 10);
  const check = () => pool("owner").query("SELECT * FROM app.audit_chain_check($1::date)", [today]);

  it.each(["shoutory_app", "shoutory_worker", "shoutory_auth", "shoutory_readonly"])(
    "is refused to %s",
    async (role) => {
      const refused = pool(role.replace("shoutory_", "") as "app").query(
        "SELECT * FROM app.audit_chain_check($1::date)",
        [today],
      );
      await expect(refused).rejects.toMatchObject({ code: "42501" });
    },
  );

  it("the hash chain verifies for a day, an empty genesis head included; editing a row as owner breaks it at that row", async () => {
    expect((await check()).rows).toEqual([]);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      await pool("auth").query(
        "SELECT app.audit_insert_instance('auth.sign_in', 'user', $1, 'req-1', NULL, '{}')",
        [`chain-${n}`],
      );
    }
    expect((await check()).rows).toEqual([]);
    const written = await rows(
      "SELECT id, tableoid::regclass::text AS leaf FROM app.audit_logs ORDER BY at, id",
    );
    ids.push(...written.map((row) => row.id as string));
    await admin(async (a) => {
      await a.query(`ALTER TABLE ${written[1]?.leaf} DISABLE TRIGGER audit_logs_immutable`);
      await a.query(`UPDATE app.audit_logs SET metadata = '{"edited":1}' WHERE id = $1`, [ids[1]]);
      await a.query(`ALTER TABLE ${written[1]?.leaf} ENABLE ALWAYS TRIGGER audit_logs_immutable`);
    });
    expect((await check()).rows.map((row) => row.id)).toEqual([ids[1]]);
  });
});

const SEED = {
  outbox: (a: Client, n: number) =>
    a.query(`INSERT INTO app.outbox (id, created_at, type, payload) VALUES ($1, now(), 'test.event', '{}')`, [
      id(n),
    ]),
  email_outbox: (a: Client, n: number) =>
    a.query(
      `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
         link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
       VALUES ($1, 'floor-1@example.test', 'verify_email', 'en', '{}', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05',
         '\\x06', 'k1', 1, 0, $2)`,
      [id(n), "d".repeat(64)],
    ),
};
const DEFINER_PAIRS = [
  { table: "outbox", claim: "outbox_claim", lapse: "claimed_until" },
  { table: "email_outbox", claim: "email_outbox_claim", lapse: "claimed_until" },
] as const;
const claimIds = (result: { rows: Record<string, unknown>[] }) =>
  result.rows.map((row) => row.id as string).sort();

// The relay reads below the cluster-wide transaction horizon, so a transaction of another test file can hold a seeded
// row back for a moment: wait until every outbox row is below it before a claim is expected to find them.
async function belowHorizon(table: string): Promise<void> {
  if (table !== "outbox") return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await rows(
      "SELECT count(*) FILTER (WHERE xid >= pg_snapshot_xmin(pg_current_snapshot()))::int AS above FROM app.outbox",
    );
    if (row?.above === 0) return;
    await wait(50);
  }
  throw new Error("an older transaction still holds the visibility horizon");
}

describe.each(DEFINER_PAIRS)("$claim", ({ table, claim, lapse }) => {
  const reset = () => admin((a) => a.query(`DELETE FROM app.${table}`));
  const lapseLeases = () => rows(`UPDATE app.${table} SET ${lapse} = now() - interval '1 second'`);
  const mark = (pool_: Pool, row: Record<string, unknown>, attempt: number) =>
    table === "outbox"
      ? pool_.query("SELECT app.outbox_mark($1, $2, $3) AS won", [row.id, row.created_at, attempt])
      : pool_.query("SELECT app.email_outbox_mark($1, $2, true) AS won", [row.id, attempt]);

  it("two claimers get disjoint rows", async () => {
    await reset();
    await admin(async (a) => {
      for (const n of [1, 2, 3, 4, 5, 6]) await SEED[table](a, n);
    });
    await belowHorizon(table);
    const first = await openTx(pool("worker"), null);
    const second = await openTx(pool("worker"), null);
    try {
      const one = await first.query(`SELECT * FROM app.${claim}(3)`);
      const two = await second.query(`SELECT * FROM app.${claim}(3)`);
      expect(claimIds(one)).toHaveLength(3);
      expect(claimIds(two)).toHaveLength(3);
      expect(new Set([...claimIds(one), ...claimIds(two)]).size).toBe(6);
    } finally {
      await first.query("ROLLBACK");
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("a stale claim cannot mark a row that was re-claimed, and the current claim's mark wins", async () => {
    await reset();
    await admin((a) => SEED[table](a, 1));
    await belowHorizon(table);
    const stale = (await pool("worker").query(`SELECT * FROM app.${claim}(1)`)).rows[0];
    await lapseLeases();
    const current = (await pool("worker").query(`SELECT * FROM app.${claim}(1)`)).rows[0];
    expect([stale?.attempts, current?.attempts]).toEqual([1, 2]);
    expect((await mark(pool("worker"), stale, 1)).rows[0]).toEqual({ won: false });
    const untouched =
      table === "outbox" ? "dispatched_at IS NULL" : "state = 'sending' AND link_ciphertext IS NOT NULL";
    expect(await rows(`SELECT count(*)::int AS n FROM app.${table} WHERE ${untouched}`)).toEqual([{ n: 1 }]);
    expect((await mark(pool("worker"), current, 2)).rows[0]).toEqual({ won: true });
  });
});

describe("outbox visibility horizon and partitions", () => {
  it("a row committed late with a lower id is still claimed, in (xid, id) order", async () => {
    await admin((a) => a.query("DELETE FROM app.outbox"));
    const slow = new Client({ connectionString: withDatabase(env.adminUrl, db.name) });
    await slow.connect();
    let later: string;
    try {
      await slow.query("BEGIN");
      await slow.query(
        `INSERT INTO app.outbox (id, created_at, type, payload) VALUES ($1, now(), 'test.late', '{}')`,
        [id(1)],
      );
      const second = await admin((a) =>
        a.query(
          `INSERT INTO app.outbox (id, created_at, type, payload) VALUES ($1, now(), 'test.event', '{}')
           RETURNING xid::text AS xid`,
          [id(2)],
        ),
      );
      later = String(second.rows[0]?.xid);
      expect((await pool("worker").query("SELECT * FROM app.outbox_claim(10)")).rows).toEqual([]);
      await slow.query("COMMIT");
    } finally {
      await slow.end();
    }
    await horizonPast(later);
    const claimed = await pool("worker").query("SELECT * FROM app.outbox_claim(10)");
    expect(claimed.rows.map((row) => row.id)).toEqual([id(1), id(2)]);
  });

  it("an outbox partition older than 7 days is dropped by purge_expired and today's stays", async () => {
    const day = (ago: number) => new Date((Math.floor(Date.now() / 864e5) - ago) * 864e5).toISOString();
    await admin(async (a) => {
      // A leaf is made by the definer role, as ensure_partitions makes it; only its owner may drop it.
      await a.query("SET ROLE shoutory_definer");
      await a.query(
        `CREATE TABLE app.outbox_floor_old PARTITION OF app.outbox FOR VALUES FROM ('${day(11)}') TO ('${day(10)}')`,
      );
      await a.query("RESET ROLE");
      await a.query(
        `INSERT INTO app.outbox (id, created_at, type, payload, dispatched_at)
         VALUES ($1, '${day(11)}', 'test.old', '{}', now())`,
        [id(9)],
      );
    });
    await pool("worker").query("SELECT app.purge_expired('outbox')");
    expect(await rows("SELECT to_regclass('app.outbox_floor_old') AS leaf")).toEqual([{ leaf: null }]);
    expect(
      await rows("SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'app.outbox'::regclass"),
    ).not.toEqual([{ n: 0 }]);
  });
});

// The horizon is the oldest transaction running anywhere in the cluster, and another test file's database drop can hold
// it for a moment: read it (without claiming anything) until it has passed the writer's transaction id.
async function horizonPast(xid: string): Promise<void> {
  const deadline = Date.now() + 3_500;
  while (Date.now() < deadline) {
    const [row] = await rows("SELECT pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8 AS past", [xid]);
    if (row?.past) return;
    await wait(20);
  }
  throw new Error("an older transaction still holds the visibility horizon");
}

describe("email_outbox lifecycle", () => {
  const state = () =>
    rows("SELECT state, attempts, link_ciphertext IS NOT NULL AS sealed, link_digest FROM app.email_outbox");

  it("a sent or terminally failed email_outbox row keeps only its digest (sealed columns NULL); a lease-lapsed row is claimable again with its sealed link; the fifth failed attempt ends in failed", async () => {
    await admin(async (a) => {
      await a.query("DELETE FROM app.email_outbox");
      await SEED.email_outbox(a, 1);
    });
    const worker = pool("worker");
    const claim = async () => (await worker.query("SELECT * FROM app.email_outbox_claim(1)")).rows[0];
    const first = await claim();
    expect(first).toMatchObject({ id: id(1), attempts: 1 });
    await rows("UPDATE app.email_outbox SET claimed_until = now() - interval '1 second'");
    const again = await claim();
    expect(again).toMatchObject({ id: id(1), attempts: 2 });
    expect(Buffer.isBuffer(again?.link_ciphertext)).toBe(true);
    for (const attempt of [2, 3, 4]) {
      await worker.query("SELECT app.email_outbox_mark($1, $2, false)", [id(1), attempt]);
      expect((await state())[0]).toMatchObject({ state: "pending", sealed: true });
      await rows("UPDATE app.email_outbox SET next_attempt_at = now()");
      expect(await claim()).toMatchObject({ attempts: attempt + 1 });
    }
    await worker.query("SELECT app.email_outbox_mark($1, 5, false)", [id(1)]);
    expect((await state())[0]).toMatchObject({ state: "failed", sealed: false, link_digest: "d".repeat(64) });
    await admin(async (a) => {
      await a.query("DELETE FROM app.email_outbox");
      await SEED.email_outbox(a, 2);
    });
    const sent = await claim();
    await worker.query("SELECT app.email_outbox_mark($1, $2, true)", [sent?.id, sent?.attempts]);
    expect((await state())[0]).toMatchObject({ state: "sent", sealed: false, link_digest: "d".repeat(64) });
  });
});

// Each class has one row just past its window (removed, id 1) and one just inside it (kept, id 2). A 1-day window
// is probed one hour either side; the others one day either side.
const ago = (interval: string) => `now() - interval '${interval}'`;
const purgeUser = (n: number, verified: boolean, created = "now()") =>
  `INSERT INTO auth."user" (id, name, email, email_verified, created_at)
   VALUES ('${id(n)}', 'purge-${n}', 'purge-${n}@example.test', ${verified}, ${created})`;
const purgeInvite = (n: number, expires: string, revoked = "NULL") =>
  `INSERT INTO app.invitations (id, workspace_id, email, role_id, token_hash, expires_at, revoked_at, invited_by)
   VALUES ('${id(n)}', '${WA}', 'purge-inv-${n}@example.test', (SELECT r.id FROM app.roles r WHERE r.key = 'editor'
     AND r.workspace_id IS NULL), sha256('purge-inv-${n}'::bytea), ${expires}, ${revoked}, '${U.admin}')`;
const purgeMail = (n: number, state: string, age: string) =>
  `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, state, created_at)
   VALUES ('${id(n)}', 'purge-${n}@example.test', 'verify_email', 'en', '{}', '${state}', ${ago(age)})`;

const PURGE_CASES: [string, string, string, (number | string)[]][] = [
  [
    "auth.session",
    `${purgeUser(11, true)}; INSERT INTO auth.session (id, expires_at, token, user_id) VALUES
       ('${id(21)}', ${ago("8 days")}, 'purge-token-1', '${id(11)}'), ('${id(22)}', ${ago("6 days")}, 'purge-token-2', '${id(11)}')`,
    "SELECT id FROM auth.session",
    [22],
  ],
  [
    "auth.verification",
    `INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES
       ('${id(31)}', 'purge-1', 'v', ${ago("25 hours")}), ('${id(32)}', 'purge-2', 'v', ${ago("23 hours")})`,
    "SELECT id FROM auth.verification",
    [32],
  ],
  [
    "app.session_step_ups",
    `${purgeUser(12, true)}; INSERT INTO app.session_step_ups (session_id, user_id, method, at) VALUES
       ('${id(41)}', '${id(12)}', 'password', ${ago("25 hours")}), ('${id(42)}', '${id(12)}', 'password', ${ago("23 hours")})`,
    "SELECT session_id AS id FROM app.session_step_ups",
    [42],
  ],
  [
    "app.rate_buckets",
    `INSERT INTO app.rate_buckets (scope, key, tokens, refilled_at) VALUES
       ('login_ip', '${"a".repeat(64)}', 60, ${ago("31 days")}), ('login_ip', '${"b".repeat(64)}', 60, ${ago("29 days")})`,
    "SELECT key AS id FROM app.rate_buckets",
    [-1],
  ],
  [
    "auth.user_unverified",
    `${purgeUser(51, false, ago("8 days"))}; ${purgeUser(52, false, ago("6 days"))}; ${purgeUser(53, true, ago("8 days"))}`,
    `SELECT id FROM auth."user" WHERE name IN ('purge-51', 'purge-52', 'purge-53')`,
    [52, 53],
  ],
  [
    "app.invitations",
    `${purgeInvite(61, ago("31 days"))}; ${purgeInvite(62, ago("29 days"))};
     ${purgeInvite(63, "now() + interval '5 days'", ago("31 days"))};
     ${purgeInvite(64, "now() + interval '5 days'", ago("29 days"))};
     ${purgeInvite(65, "now() + interval '5 days'")}`,
    "SELECT id FROM app.invitations WHERE email LIKE 'purge-inv-%'",
    [62, 64, 65],
  ],
  [
    "app.worker_heartbeats",
    `INSERT INTO app.worker_heartbeats (worker_id, role, started_at, seen_at) VALUES
       ('purge-w-old', 'worker', ${ago("9 days")}, ${ago("8 days")}),
       ('purge-w-new', 'worker', ${ago("9 days")}, ${ago("6 days")})`,
    "SELECT worker_id AS id FROM app.worker_heartbeats",
    ["purge-w-new"],
  ],
  [
    "email_outbox",
    `DELETE FROM app.email_outbox; ${purgeMail(71, "sent", "31 days")}; ${purgeMail(72, "sent", "29 days")}; ${purgeMail(73, "failed", "31 days")};
     ${purgeMail(74, "pending", "40 days")}`,
    "SELECT id FROM app.email_outbox",
    [72, 74],
  ],
];

describe("purge_expired", () => {
  it.each(PURGE_CASES)(
    "%s: a row past its window is removed and one inside it kept",
    async (klass, plant, read, kept) => {
      await admin((a) => a.query(plant));
      await pool("worker").query("SELECT app.purge_expired($1)", [klass]);
      const left = (await rows(read)).map((row) => String(row.id));
      const expected = kept.map((k) => (k === -1 ? "b".repeat(64) : typeof k === "number" ? id(k) : k));
      expect(left.sort()).toEqual(expected.sort());
    },
  );
});
