import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
  withDatabase,
} from "../../src/testing/template.js";

const env = readTestEnv();

const ROLES = [
  { name: "shoutory_owner", login: true, key: "owner" },
  { name: "shoutory_definer", login: false, key: undefined },
  { name: "shoutory_app", login: true, key: "app" },
  { name: "shoutory_worker", login: true, key: "worker" },
  { name: "shoutory_auth", login: true, key: "auth" },
  { name: "shoutory_readonly", login: true, key: "readonly" },
] as const;

const FLAGS = [
  ["rolsuper", "superuser"],
  ["rolbypassrls", "bypassrls"],
  ["rolcreaterole", "createrole"],
  ["rolcreatedb", "createdb"],
] as const;

async function attributeViolations(pool: Pool, role: string, login: boolean): Promise<string[]> {
  const attrs = (await pool.query("SELECT * FROM pg_roles WHERE rolname = $1", [role])).rows[0];
  if (!attrs) return ["role is missing"];
  const found: string[] = FLAGS.filter(([column]) => attrs[column]).map(([, label]) => label);
  if (attrs.rolcanlogin !== login) found.push(login ? "cannot log in" : "can log in");
  return found;
}

async function membershipViolations(pool: Pool, role: string): Promise<string[]> {
  const direct = await pool.query(
    `SELECT r.rolname AS granted, am.inherit_option, am.set_option FROM pg_auth_members am
     JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
     WHERE m.rolname = $1`,
    [role],
  );
  // Membership one step removed (through any other role) also reaches the owner or definer role.
  const indirect = await pool.query(
    `SELECT target FROM unnest(ARRAY['shoutory_owner', 'shoutory_definer']) AS target
     WHERE target <> $1 AND pg_has_role($1, target, 'MEMBER')`,
    [role],
  );
  // The migration owner may switch to the definer role to hand it functions, and inherits nothing from it.
  const allowed = (row: { granted: string; inherit_option: boolean; set_option: boolean }) =>
    role === "shoutory_owner" && row.granted === "shoutory_definer" && !row.inherit_option && row.set_option;
  const found = [
    ...direct.rows.filter((row) => !allowed(row)).map((row) => row.granted as string),
    ...indirect.rows
      .map((row) => row.target as string)
      .filter((target) => !(role === "shoutory_owner" && target === "shoutory_definer")),
  ];
  return [...new Set(found)].map((name) => `member of ${name}`);
}

async function createViolations(pool: Pool, role: string): Promise<string[]> {
  if (role === "shoutory_owner") return [];
  const create = await pool.query(
    `SELECT has_schema_privilege($1, 'app', 'CREATE') AS app, has_schema_privilege($1, 'auth', 'CREATE') AS auth,
            has_database_privilege($1, current_database(), 'CREATE') AS database`,
    [role],
  );
  const row = create.rows[0];
  // The NOLOGIN definer holds CREATE on app: ALTER FUNCTION ... OWNER TO needs it. Nothing else may.
  const exempt = role === "shoutory_definer" ? "app" : undefined;
  return (["app", "auth", "database"] as const)
    .filter((place) => row[place] && place !== exempt)
    .map((place) => `CREATE on ${place}`);
}

async function violations(pool: Pool, role: string, login: boolean): Promise<string[]> {
  return [
    ...(await attributeViolations(pool, role, login)),
    ...(await membershipViolations(pool, role)),
    ...(await createViolations(pool, role)),
  ];
}

describe("database roles", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it.each(ROLES)("$name has none of the forbidden attributes or memberships", async ({ name, login }) => {
    expect(await violations(db.pool("owner"), name, login)).toEqual([]);
  });

  it.each(ROLES.filter((role) => role.key))("$name logs in with its own password", async ({ name, key }) => {
    const who = await db.pool(key as "owner").query("SELECT current_user AS who");
    expect(who.rows).toEqual([{ who: name }]);
  });

  // Runtime roles reach the app schema through grants only; the auth schema is the auth role's.
  it.each([
    ["shoutory_app", true, false],
    ["shoutory_worker", true, false],
    ["shoutory_readonly", true, false],
    ["shoutory_auth", true, true],
    ["shoutory_definer", true, true],
  ])("%s has usage on app=%s and auth=%s", async (role, app, auth) => {
    const usage = await db
      .pool("owner")
      .query(
        "SELECT has_schema_privilege($1, 'app', 'USAGE') AS app, has_schema_privilege($1, 'auth', 'USAGE') AS auth",
        [role],
      );
    expect(usage.rows).toEqual([{ app, auth }]);
  });
});

// The one CREATE exemption: the definer holds CREATE on app and cannot log in; any other CREATE is still named.
describe("the definer's CREATE exemption", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it("shoutory_definer holds CREATE on app, not on auth or the database, and cannot log in", async () => {
    const found = await db.pool("owner").query(
      `SELECT has_schema_privilege('shoutory_definer', 'app', 'CREATE') AS app,
              has_schema_privilege('shoutory_definer', 'auth', 'CREATE') AS auth,
              has_database_privilege('shoutory_definer', current_database(), 'CREATE') AS database,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'shoutory_definer') AS login`,
    );
    expect(found.rows).toEqual([{ app: true, auth: false, database: false, login: false }]);
  });

  it.each([
    ["GRANT CREATE ON SCHEMA auth TO shoutory_definer", "shoutory_definer", "CREATE on auth"],
    ["GRANT CREATE ON SCHEMA app TO shoutory_app", "shoutory_app", "CREATE on app"],
  ])("a planted %s is named", async (statement, role, expected) => {
    await withAdminClient(env, db.name, async (admin) => {
      await admin.query(statement);
      try {
        expect(await violations(db.pool("owner"), role, role === "shoutory_app")).toContain(expected);
      } finally {
        await admin.query(statement.replace("GRANT", "REVOKE").replace(" TO ", " FROM "));
      }
    });
  });
});

describe("the owner's one allowed membership", () => {
  it("is the definer row and nothing else: a second membership is refused", async () => {
    const db = await cloneTemplate(env, inject("shoutoryTemplate"));
    const admin = new Client({ connectionString: withDatabase(env.adminUrl, db.name) });
    await admin.connect();
    try {
      expect(await violations(db.pool("owner"), "shoutory_owner", true)).toEqual([]);
      await admin.query("GRANT pg_read_all_data TO shoutory_owner");
      expect(await violations(db.pool("owner"), "shoutory_owner", true)).toEqual([
        "member of pg_read_all_data",
      ]);
    } finally {
      await admin.query("REVOKE pg_read_all_data FROM shoutory_owner");
      await admin.end();
      await db.drop();
    }
  });
});

describe("the role catalog check catches a planted violation", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it.each([
    ["SUPERUSER", "superuser"],
    ["BYPASSRLS", "bypassrls"],
    ["CREATEROLE", "createrole"],
    ["CREATEDB", "createdb"],
    ["IN ROLE shoutory_definer", "member of shoutory_definer"],
    ["IN ROLE shoutory_owner", "member of shoutory_owner"],
    ["IN ROLE pg_read_all_data", "member of pg_read_all_data"],
    ["IN ROLE pg_write_all_data", "member of pg_write_all_data"],
    // The membership is one step removed: the probe joins an intermediate role that joined the owner role.
    ["IN ROLE {mid}", "member of shoutory_owner"],
    ["IN ROLE {mid_definer}", "member of shoutory_definer"],
  ])("a role created with %s", async (attribute, expected) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const probe = `shoutory_probe_${suffix}`;
    const mid = `shoutory_mid_${suffix}`;
    const midDefiner = `shoutory_middef_${suffix}`;
    const admin = new Client({ connectionString: withDatabase(env.adminUrl, db.name) });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${mid} NOLOGIN IN ROLE shoutory_owner`);
      await admin.query(`CREATE ROLE ${midDefiner} NOLOGIN IN ROLE shoutory_definer`);
      const clause = attribute.replace("{mid_definer}", midDefiner).replace("{mid}", mid);
      await admin.query(`CREATE ROLE ${probe} LOGIN ${clause}`);
      expect(await violations(db.pool("owner"), probe, true)).toContain(expected);
    } finally {
      for (const name of [probe, mid, midDefiner]) await admin.query(`DROP ROLE IF EXISTS ${name}`);
      await admin.end();
    }
  });
});
