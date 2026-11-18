import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor of migration 0006: the outbox holds a sealed link that only definer functions may touch. The
// runtime roles hold no table privilege; each definer is owned by the definer role, pins its search path and is
// executable by exactly its callers; each purpose policy opens only the read it names.
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
const RUNTIME_ROLES = ["shoutory_app", "shoutory_worker", "shoutory_auth", "shoutory_readonly"];
const DEFINERS = [
  { name: "email_outbox_enqueue", callers: ["shoutory_auth", "shoutory_app"] },
  { name: "sealed_key_ids", callers: ["shoutory_app", "shoutory_worker"] },
  { name: "email_outbox_reseal_batch", callers: ["shoutory_worker"] },
  { name: "email_outbox_reseal_write", callers: ["shoutory_worker"] },
];

const hex = (n: number) => `\\x${n.toString(16).padStart(2, "0").repeat(4)}`;
// Time-ordered ids, so the batch order is the insert order.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** One sealed row; the bytes are placeholders, the definers never open a link. */
async function seed(admin: Client, n: number, keyId: string, generation = 0, sealed = true): Promise<void> {
  const part = (value: string) => (sealed ? value : null);
  await admin.query(
    `INSERT INTO app.email_outbox (id, recipient, template, locale, vars, link_ciphertext, link_iv, link_auth_tag,
       link_wrap_iv, link_wrap_tag, link_wrapped_dek, link_key_id, link_format_version, link_generation, link_digest)
     VALUES ($1, 'outbox-1@example.test', 'verify_email', 'en', '{}', $2::bytea, $3::bytea, $4::bytea, $5::bytea,
       $6::bytea, $7::bytea, $8, $9, $10, $11)`,
    [
      id(n),
      part(hex(1)),
      part(hex(2)),
      part(hex(3)),
      part(hex(4)),
      part(hex(5)),
      part(hex(6)),
      part(keyId),
      sealed ? 1 : null,
      sealed ? generation : null,
      "d".repeat(64),
    ],
  );
}

let db: TestDatabase;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
type Role = Parameters<TestDatabase["pool"]>[0];
const pool = (role: Role): Pool => db.pool(role);
const clear = () => withAdminClient(env, db.name, (admin) => admin.query("DELETE FROM app.email_outbox"));

describe("email_outbox: table and grants", () => {
  it.each(RUNTIME_ROLES)("%s holds no privilege on the table", async (role) => {
    const found = await Promise.all(
      PRIVILEGES.map(async (privilege) => {
        const has = await pool("owner").query(
          "SELECT has_table_privilege($1, 'app.email_outbox', $2) AS has",
          [role, privilege],
        );
        return has.rows[0].has as boolean;
      }),
    );
    expect(found).toEqual(PRIVILEGES.map(() => false));
  });

  it("a direct INSERT by the auth role is refused", async () => {
    const insert = pool("auth").query(
      `INSERT INTO app.email_outbox (id, recipient, template, locale, vars) VALUES ($1, 'direct-1@example.test', 'verify_email', 'en', '{}')`,
      [randomUUID()],
    );
    await expect(insert).rejects.toMatchObject({ code: "42501" });
  });
});

describe("email_outbox: definers", () => {
  const catalog = (name: string) =>
    pool("owner").query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig FROM pg_proc p
       WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1`,
      [name],
    );

  it.each(DEFINERS)("$name is owned by the definer, with a pinned path", async ({ name }) => {
    expect((await catalog(name)).rows).toEqual([
      { owner: "shoutory_definer", prosecdef: true, proconfig: ["search_path=pg_catalog, app, pg_temp"] },
    ]);
  });

  it.each(DEFINERS)("$name is executable by exactly its callers and never by PUBLIC", async (d) => {
    const found = await pool("owner").query(
      `SELECT coalesce(r.rolname, 'PUBLIC') AS grantee
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.pronamespace = 'app'::regnamespace AND p.proname = $1 AND a.privilege_type = 'EXECUTE'`,
      [d.name],
    );
    expect(found.rows.map((row) => row.grantee).sort()).toEqual([...d.callers, "shoutory_definer"].sort());
  });

  // The definer role sees a row only under the purpose that names its read.
  const countAs = async (purpose: string | undefined) => {
    const client = await pool("owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE shoutory_definer");
      if (purpose) await client.query("SELECT set_config('app.job_purpose', $1, true)", [purpose]);
      return (await client.query("SELECT count(*)::int AS n FROM app.email_outbox")).rows[0].n as number;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  };

  it.each([
    ["sealed_key_ids", 1],
    ["email_outbox_reseal_batch", 1],
    ["email_outbox_enqueue", 0],
    ["unrelated_purpose", 0],
    [undefined, 0],
  ] as const)("the definer role sees %s rows under the purpose %s", async (purpose, rows) => {
    await clear();
    await withAdminClient(env, db.name, (admin) => seed(admin, 1, "k1"));
    expect(await countAs(purpose)).toBe(rows);
  });
});

// R91: a definer puts the caller's job purpose back at exit.
describe("email_outbox: definers restore the job purpose", () => {
  const calls = (): [string, string, string, unknown[]][] => [
    ["sealed_key_ids", "app", "SELECT * FROM app.sealed_key_ids()", []],
    [
      "email_outbox_reseal_batch",
      "worker",
      "SELECT * FROM app.email_outbox_reseal_batch(10, 'k2', NULL)",
      [],
    ],
    [
      "email_outbox_reseal_write",
      "worker",
      `SELECT app.email_outbox_reseal_write($1, 0, '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea,
         '\\x01'::bytea, '\\x01'::bytea, 'k2', 1)`,
      [id(1)],
    ],
    [
      "email_outbox_enqueue",
      "auth",
      `SELECT app.email_outbox_enqueue(id => $1, workspace_id => NULL, recipient => 'enqueue-1@example.test',
         template => 'verify_email', locale => 'en', vars => '{}'::jsonb, link_ciphertext => '\\x01'::bytea,
         link_iv => '\\x01'::bytea, link_auth_tag => '\\x01'::bytea, link_wrap_iv => '\\x01'::bytea,
         link_wrap_tag => '\\x01'::bytea, link_wrapped_dek => '\\x01'::bytea, link_key_id => 'k1',
         link_format_version => 1, link_digest => $2)`,
      [randomUUID(), "e".repeat(64)],
    ],
  ];

  it.each(
    calls().flatMap(([name, role, sql, args]) => [
      [name, role, "x", sql, args] as const,
      [name, role, undefined, sql, args] as const,
    ]),
  )("%s as %s restores the caller's purpose (prior %s)", async (_name, role, prior, sql, args) => {
    await clear();
    await withAdminClient(env, db.name, (admin) => seed(admin, 1, "k1"));
    const client = await pool(role as Role).connect();
    try {
      await client.query("BEGIN");
      if (prior) await client.query("SELECT set_config('app.job_purpose', $1, true)", [prior]);
      await client.query(sql, args as unknown[]);
      const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
      expect(after.rows[0].purpose || undefined).toBe(prior);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("email_outbox: key ids and reseal batches", () => {
  beforeEach(clear);
  const worker = (): Pool => pool("worker");
  const sealedWrite = (n: number, expected: number, key = "k2") =>
    worker().query(
      `SELECT app.email_outbox_reseal_write($1, $2, '\\x0a0a0a0a'::bytea, '\\x0b0b0b0b'::bytea, '\\x0c0c0c0c'::bytea,
         '\\x0d0d0d0d'::bytea, '\\x0e0e0e0e'::bytea, '\\x0f0f0f0f'::bytea, $3, 1) AS written`,
      [id(n), expected, key],
    );

  it("sealed_key_ids answers the distinct key ids of rows that still hold a link, and not a sent row", async () => {
    await withAdminClient(env, db.name, async (admin) => {
      await seed(admin, 1, "k1");
      await seed(admin, 2, "k1");
      await seed(admin, 3, "k2");
      await seed(admin, 4, "gone", 0, false);
    });
    const found = await pool("app").query("SELECT * FROM app.sealed_key_ids() AS k ORDER BY 1");
    expect(found.rows.map((row) => Object.values(row)[0])).toEqual(["k1", "k2"]);
  });

  it("the batch lists rows under another key in id order after the cursor, and skips sent rows and the active key", async () => {
    await withAdminClient(env, db.name, async (admin) => {
      await seed(admin, 1, "k1");
      await seed(admin, 2, "k2");
      await seed(admin, 3, "k1");
      await seed(admin, 4, "k1", 0, false);
      await seed(admin, 5, "k3");
    });
    const first = await worker().query("SELECT id FROM app.email_outbox_reseal_batch(2, 'k2', NULL)");
    expect(first.rows.map((row) => row.id)).toEqual([id(1), id(3)]);
    const next = await worker().query("SELECT id FROM app.email_outbox_reseal_batch(2, 'k2', $1)", [id(3)]);
    expect(next.rows.map((row) => row.id)).toEqual([id(5)]);
  });

  it.each([[0], [501]])("a batch limit of %i is refused", async (limit) => {
    const call = worker().query("SELECT * FROM app.email_outbox_reseal_batch($1, 'k2', NULL)", [limit]);
    await expect(call).rejects.toMatchObject({ code: "22023" });
  });

  it("a reseal write moves the generation by one, and a stale generation or a sent row is refused", async () => {
    await withAdminClient(env, db.name, async (admin) => {
      await seed(admin, 1, "k1", 4);
      await seed(admin, 2, "k1", 0, false);
    });
    expect((await sealedWrite(1, 3)).rows[0].written).toBe(false);
    expect((await sealedWrite(2, 0)).rows[0].written).toBe(false);
    expect((await sealedWrite(1, 4)).rows[0].written).toBe(true);
    expect((await sealedWrite(1, 4)).rows[0].written).toBe(false);
    const row = await withAdminClient(env, db.name, (admin) =>
      admin.query("SELECT link_key_id, link_generation FROM app.email_outbox WHERE id = $1", [id(1)]),
    );
    expect(row.rows).toEqual([{ link_key_id: "k2", link_generation: 5 }]);
  });
});
