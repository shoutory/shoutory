import { is } from "drizzle-orm";
import { getTableConfig, integer, PgTable, text } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import * as schema from "../../src/schema.js";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// The Drizzle metadata is hand-written next to the migrations, so a column that differs from the migrated catalog
// in name, type or nullability is drift. drizzle-kit has no read-only live diff at the pin, so the catalog is read here.
const declared: PgTable[] = [];
for (const value of Object.values(schema)) if (is(value, PgTable)) declared.push(value as PgTable);
const nameOf = (table: PgTable): string => `${getTableConfig(table).schema}.${getTableConfig(table).name}`;

async function drift(pool: Pool, table: PgTable): Promise<string[]> {
  const config = getTableConfig(table);
  const found = await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
     FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`${config.schema ?? "public"}.${config.name}`],
  );
  const catalog = new Map(found.rows.map((row) => [row.name as string, row]));
  const problems: string[] = [];
  for (const column of config.columns) {
    const actual = catalog.get(column.name);
    if (!actual) problems.push(`${column.name}: not in the catalog`);
    else if (actual.type !== column.getSQLType()) problems.push(`${column.name}: type ${actual.type}`);
    else if (actual.not_null !== column.notNull) problems.push(`${column.name}: nullability`);
    catalog.delete(column.name);
  }
  for (const name of catalog.keys()) problems.push(`${name}: not declared`);
  return [...problems, ...(await primaryKeyDrift(pool, table))];
}

// The primary key columns, in key order, as the catalog has them and as the metadata declares them.
async function primaryKeyDrift(pool: Pool, table: PgTable): Promise<string[]> {
  const config = getTableConfig(table);
  const found = await pool.query(
    `SELECT a.attname AS name FROM pg_index i
     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k (attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY k.ord`,
    [`${config.schema ?? "public"}.${config.name}`],
  );
  const actual = found.rows.map((row) => row.name as string);
  const declaredKey = config.primaryKeys.length
    ? (config.primaryKeys[0]?.columns.map((column) => column.name) ?? [])
    : config.columns.filter((column) => column.primary).map((column) => column.name);
  return actual.join(",") === declaredKey.join(",")
    ? []
    : [`primary key: catalog (${actual.join(",")}), declared (${declaredKey.join(",")})`];
}

const MIGRATED_TABLES = [
  "app.audit_heads",
  "app.audit_logs",
  "app.channel_capability_snapshots",
  "app.channel_credentials",
  "app.channels",
  "app.connect_challenges",
  "app.email_outbox",
  "app.email_suppressions",
  "app.feature_flag_overrides",
  "app.feature_flags",
  "app.idempotency_keys",
  "app.instance_admins",
  "app.instance_settings",
  "app.invitations",
  "app.media_assets",
  "app.media_derivatives",
  "app.media_uploads",
  "app.oauth_flows",
  "app.organization_members",
  "app.organizations",
  "app.outbox",
  "app.post_media",
  "app.post_variants",
  "app.post_versions",
  "app.posts",
  "app.provider_apps",
  "app.provider_instance_apps",
  "app.rate_buckets",
  "app.retention_classes",
  "app.roles",
  "app.schema_migrations",
  "app.session_step_ups",
  "app.sync_cursors",
  "app.user_profiles",
  "app.worker_heartbeats",
  "app.workspace_key_salts",
  "app.workspace_members",
  "app.workspaces",
  "auth.account",
  "auth.session",
  "auth.two_factor",
  "auth.user",
  "auth.verification",
];

describe("Drizzle metadata equals the migrated catalog", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  it("declares every table of the migrations so far", () => {
    expect(declared.map(nameOf).sort()).toEqual(MIGRATED_TABLES);
  });

  it.each(declared.map((table) => [nameOf(table), table] as const))(
    "%s has no drift",
    async (_name, table) => {
      expect(await drift(db.pool("owner"), table)).toEqual([]);
    },
  );

  it("a column with another type, another nullability or a missing declaration is reported", async () => {
    const fixture = schema.app.table("schema_migrations", {
      name: integer("name"),
      checksum: text("checksum"),
    });
    expect(await drift(db.pool("owner"), fixture)).toEqual([
      "name: type text",
      "checksum: nullability",
      "applied_at: not declared",
      "primary key: catalog (name), declared ()",
    ]);
  });
});
