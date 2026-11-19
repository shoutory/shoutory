import { randomUUID } from "node:crypto";
import type { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs } from "../support/members-seed.js";

const env = readTestEnv();

/** Commits one statement as a user; the error comes back, so a missing definer fails an assertion, not the run. */
async function commit(pool: Pool, user: string, sql: string, params: unknown[]): Promise<unknown> {
  try {
    await commitAs(pool, user, sql, params);
    return undefined;
  } catch (error) {
    return error;
  }
}

// Security floor of the flags slice: a reader sees only the overrides of its own scope, and instance-wide state
// changes only by an instance admin, with an audit row. (FORCE RLS and the empty runtime grants of the two tables are
// asserted by rls-catalog and runtime-grants.)
const OA = randomUUID();
const OB = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const ADMIN = randomUUID();
const OUTSIDER = randomUUID();
const LIVE = "flag-live-1";
const EXPIRED = "flag-expired-1";

interface Fixture {
  db: () => TestDatabase;
  /** The error the seed ended with, if any: a missing table fails the tests by assertion, not by a crash. */
  seeded: () => unknown;
  rows: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

async function seed(a: Client): Promise<void> {
  await a.query(
    `INSERT INTO auth."user" (id, name, email) VALUES
       ('${ADMIN}', 'flags-admin', 'flags-admin@example.test'), ('${OUTSIDER}', 'flags-outsider', 'flags-outsider@example.test')`,
  );
  await a.query("INSERT INTO app.instance_admins (user_id) VALUES ($1)", [ADMIN]);
  await a.query(
    `INSERT INTO app.organizations (id, name, slug, type) VALUES
       ('${OA}', 'flags-org-a', 'flags-org-a', 'team'), ('${OB}', 'flags-org-b', 'flags-org-b', 'team')`,
  );
  await a.query(
    `INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES
       ('${WA}', '${OA}', 'flags-ws-a', 'flags-ws-a'), ('${WB}', '${OB}', 'flags-ws-b', 'flags-ws-b')`,
  );
}

async function seedFlags(a: Client): Promise<void> {
  await a.query(
    `INSERT INTO app.feature_flags (key, description, owner, remove_by, default_on) VALUES
       ('${LIVE}', 'a live flag', 'flags-owner', current_date + 90, false),
       ('${EXPIRED}', 'a flag past its date', 'flags-owner', date '2000-01-01', false)`,
  );
  await a.query(
    `INSERT INTO app.feature_flag_overrides (flag_key, scope, scope_id, "on") VALUES
       ('${LIVE}', 'instance', NULL, true), ('${LIVE}', 'organization', '${OA}', false),
       ('${LIVE}', 'organization', '${OB}', true), ('${LIVE}', 'workspace', '${WA}', true),
       ('${LIVE}', 'workspace', '${WB}', false)`,
  );
}

function useDatabase(withFlags: boolean): Fixture {
  let db: TestDatabase;
  let seeded: unknown;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
    await withAdminClient(env, db.name, seed);
    try {
      if (withFlags) await withAdminClient(env, db.name, seedFlags);
    } catch (error) {
      seeded = error;
    }
  });
  afterAll(() => db.drop());
  const rows = (sql: string, params?: unknown[]) =>
    withAdminClient(env, db.name, async (a) => (await a.query(sql, params)).rows);
  return { db: () => db, seeded: () => seeded, rows };
}

describe("flags_read", () => {
  const t = useDatabase(true);
  const ids = (rows: Record<string, unknown>[]) =>
    rows.map((r) => `${r.flag_key}|${r.scope ?? ""}|${r.scope_id ?? ""}`).sort();

  it.each([
    [
      "app",
      "a workspace of organization A",
      { principalKind: "user", organizationId: OA, workspaceIds: [WA] },
      [`${EXPIRED}||`, `${LIVE}|instance|`, `${LIVE}|organization|${OA}`, `${LIVE}|workspace|${WA}`],
    ],
    [
      "worker",
      "a workspace of organization B",
      { principalKind: "job", organizationId: OB, workspaceIds: [WB] },
      [`${EXPIRED}||`, `${LIVE}|instance|`, `${LIVE}|organization|${OB}`, `${LIVE}|workspace|${WB}`],
    ],
    [
      "app",
      "a user with no workspace or organization",
      { principalKind: "user", principalId: OUTSIDER },
      [`${EXPIRED}||`, `${LIVE}|instance|`],
    ],
  ] as ["app" | "worker", string, TenantCtx, string[]][])(
    "returns, for %s as %s, only the overrides of that scope",
    async (role, _title, ctx, expected) => {
      expect(t.seeded()).toBeUndefined();
      const result = await attempt(
        t.db().pool(role),
        ctx,
        "SELECT flag_key, scope, scope_id, override_on FROM app.flags_read()",
      );
      expect(result.error).toBeUndefined();
      expect(ids(result.rows ?? [])).toEqual([...expected].sort());
    },
  );
});

const flagOverrides = (t: Fixture) =>
  t.rows(`SELECT flag_key, scope, scope_id, "on" FROM app.feature_flag_overrides WHERE scope = 'instance'`);
const auditRows = (t: Fixture, action: string) =>
  t.rows(
    `SELECT workspace_id, organization_id, actor_kind, actor_ref, resource_kind, resource_id, request_id,
       encode(ip_hmac, 'hex') AS ip_hmac
     FROM app.audit_logs WHERE action = $1`,
    [action],
  );
const REQUEST = "req-flags-1";
const ADDRESS = Buffer.alloc(32, 7);
const ADDRESS_HEX = ADDRESS.toString("hex");
const OVERRIDE_SQL = "SELECT app.feature_flag_override_set($1, $2, $3, $4)";
/** The one instance-chain audit row an admin write leaves: no workspace, the admin as actor, the request and address. */
const instanceAuditRow = (resourceKind: string, resourceId: string) => ({
  workspace_id: null,
  organization_id: null,
  actor_kind: "user",
  actor_ref: ADMIN,
  resource_kind: resourceKind,
  resource_id: resourceId,
  request_id: REQUEST,
  ip_hmac: ADDRESS_HEX,
});

describe("feature_flag_override_set", () => {
  const t = useDatabase(true);
  const pool = () => t.db().pool("app");

  it("lets an instance admin set an instance override and writes one instance-chain audit row", async () => {
    expect(t.seeded()).toBeUndefined();
    const before = await flagOverrides(t);
    expect(await commit(pool(), ADMIN, OVERRIDE_SQL, [LIVE, false, REQUEST, ADDRESS])).toBeUndefined();
    const after = await flagOverrides(t);
    expect(before).toEqual([{ flag_key: LIVE, scope: "instance", scope_id: null, on: true }]);
    expect(after).toEqual([{ flag_key: LIVE, scope: "instance", scope_id: null, on: false }]);
    expect(await auditRows(t, "flag.override_set")).toEqual([instanceAuditRow("feature_flag", LIVE)]);
  });

  it.each([
    ["a user who is not an instance admin", { principalKind: "user", principalId: OUTSIDER }, LIVE, "42501"],
    [
      "an admin's id under a service principal",
      { principalKind: "service", principalId: ADMIN },
      LIVE,
      "42501",
    ],
    ["no principal at all", {}, LIVE, "42501"],
    ["an unknown flag key", { principalKind: "user", principalId: ADMIN }, "flag-unknown-1", "22023"],
    ["a flag whose remove_by is past", { principalKind: "user", principalId: ADMIN }, EXPIRED, "22023"],
  ] as const)("refuses %s", async (_title, ctx, key, code) => {
    expect(t.seeded()).toBeUndefined();
    const result = await attempt(pool(), ctx, OVERRIDE_SQL, [key, true, REQUEST, ADDRESS]);
    expect(result.error).toMatchObject({ code });
  });

  it("removes only the instance override when the value is NULL and audits it with on = null", async () => {
    expect(t.seeded()).toBeUndefined();
    expect(await commit(pool(), ADMIN, OVERRIDE_SQL, [LIVE, null, REQUEST, ADDRESS])).toBeUndefined();
    expect(await flagOverrides(t)).toEqual([]);
    const kept = await t.rows("SELECT scope, scope_id FROM app.feature_flag_overrides WHERE flag_key = $1", [
      LIVE,
    ]);
    expect(kept.map((row) => `${row.scope}|${row.scope_id}`).sort()).toEqual(
      [`organization|${OA}`, `organization|${OB}`, `workspace|${WA}`, `workspace|${WB}`].sort(),
    );
    const audited = await t.rows(
      `SELECT resource_id FROM app.audit_logs WHERE action = 'flag.override_set' AND metadata = '{"on": null}'`,
    );
    expect(audited).toEqual([{ resource_id: LIVE }]);
  });
});

describe("instance_setting_set and instance_admin_check", () => {
  const t = useDatabase(false);
  const pool = () => t.db().pool("app");

  it("instance_setting_set writes one instance-chain audit row for the admin who changed the setting", async () => {
    const sql = "SELECT app.instance_setting_set('signup_enabled', 'true'::jsonb, $1, $2)";
    expect(await commit(pool(), ADMIN, sql, [REQUEST, ADDRESS])).toBeUndefined();
    expect(await auditRows(t, "instance.setting_set")).toEqual([
      instanceAuditRow("instance_setting", "signup_enabled"),
    ]);
  });

  it.each([
    ["an instance admin", asUser(ADMIN), true],
    ["a user who is not an instance admin", asUser(OUTSIDER), false],
    ["an admin's id under a service principal", { principalKind: "service", principalId: ADMIN }, false],
    ["no principal at all", {}, false],
  ] as const)("instance_admin_check answers %s with %s", async (_title, ctx, expected) => {
    const result = await attempt(pool(), ctx, "SELECT app.instance_admin_check() AS ok");
    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([{ ok: expected }]);
  });
});
