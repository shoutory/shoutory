import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { migrateDatabase } from "../migrate/runner.js";

const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
type DbRole = (typeof ROLES)[number];

export interface TestEnv {
  /** Cloning a template needs more than the owner role holds, so only tests use this superuser URL. */
  adminUrl: string;
  roleUrls: Record<DbRole, string>;
}

export interface TestDatabase {
  name: string;
  url(role: DbRole): string;
  pool(role: DbRole): Pool;
  drop(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 5_000;

// A missing setting fails the run: database tests are never skipped.
export function readTestEnv(env: NodeJS.ProcessEnv = process.env): TestEnv {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`${name} is not set; the database tests need a running PostgreSQL (see README)`);
    }
    return value;
  };
  const roleUrls = Object.fromEntries(
    ROLES.map((role) => [role, need(`SHOUTORY_DATABASE_URL_${role.toUpperCase()}`)]),
  ) as Record<DbRole, string>;
  return { adminUrl: need("SHOUTORY_TEST_ADMIN_URL"), roleUrls };
}

export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function asAdmin<T>(env: TestEnv, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.adminUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

// Names are generated here and never contain a quote, so quoting them is enough.
async function createDatabase(env: TestEnv, source?: string): Promise<string> {
  const name = `shoutory_test_${randomUUID().replaceAll("-", "_")}`;
  const template = source ? ` TEMPLATE "${source}"` : "";
  await asAdmin(env, (client) => client.query(`CREATE DATABASE "${name}" OWNER shoutory_owner${template}`));
  return name;
}

export interface RoleLogin {
  url(database: string): string;
  drop(): Promise<void>;
}

// The development password of a role is a known example value that the API refuses at start-up, so a start-up test
// needs a login with another password.
export async function createRoleLogin(env: TestEnv, role: "app" | "worker" = "app"): Promise<RoleLogin> {
  const id = randomUUID().replaceAll("-", "_");
  const name = `shoutory_login_${id}`;
  const password = `login-secret-${id}`;
  await asAdmin(env, (client) =>
    client.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' IN ROLE shoutory_${role}`),
  );
  return {
    url(database) {
      const url = new URL(withDatabase(env.roleUrls[role], database));
      url.username = name;
      url.password = password;
      return url.toString();
    },
    drop: () => asAdmin(env, async (client) => void (await client.query(`DROP ROLE IF EXISTS "${name}"`))),
  };
}

// Seeding rows the runtime roles cannot write and moving time need the superuser: the migration owner sees no rows
// of a FORCE table without a policy.
export async function withAdminClient<T>(
  env: TestEnv,
  database: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: withDatabase(env.adminUrl, database),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(env: TestEnv, name: string): Promise<void> {
  await asAdmin(env, (client) => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

export async function createTemplate(env: TestEnv): Promise<string> {
  const name = await createDatabase(env);
  try {
    await migrateDatabase(withDatabase(env.roleUrls.owner, name));
  } catch (error) {
    await dropDatabase(env, name);
    throw error;
  }
  return name;
}

export function cloneTemplate(env: TestEnv, template: string): Promise<TestDatabase> {
  return open(env, template);
}

export function emptyDatabase(env: TestEnv): Promise<TestDatabase> {
  return open(env);
}

async function open(env: TestEnv, template?: string): Promise<TestDatabase> {
  const name = await createDatabase(env, template);
  // One pool per role for the life of the clone: a pool per call would each hold connections until the drop and
  // exhaust the server's connection slots when many test files run at once.
  const pools = new Map<DbRole, Pool>();
  let dropped = false;
  // pool.end() resolves before each socket has closed; dropping the database with FORCE in that gap kills a
  // connection that is still shutting down and the client reports it as an uncaught error.
  const closed: Promise<void>[] = [];
  const trackClose = (pool: Pool): void => {
    pool.on("connect", (client) => {
      closed.push(
        new Promise<void>((resolve) => {
          const onRemove = (removed: unknown): void => {
            if (removed !== client) return;
            pool.off("remove", onRemove);
            resolve();
          };
          pool.on("remove", onRemove);
        }),
      );
    });
  };
  const url = (role: DbRole): string => withDatabase(env.roleUrls[role], name);
  return {
    name,
    url,
    pool(role) {
      if (dropped) throw new Error(`the test database ${name} was dropped`);
      const existing = pools.get(role);
      if (existing) return existing;
      const pool = new Pool({
        connectionString: url(role),
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        max: 4,
      });
      trackClose(pool);
      pools.set(role, pool);
      return pool;
    },
    async drop() {
      // From here no new pool may open: it would connect to a database that the drop below terminates, and the pool
      // would report the killed connection as an uncaught error.
      dropped = true;
      await Promise.all([...pools.values()].map((pool) => pool.end()));
      await Promise.all(closed);
      await dropDatabase(env, name);
    },
  };
}
