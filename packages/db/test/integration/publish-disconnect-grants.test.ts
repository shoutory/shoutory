import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";

const env = readTestEnv();

let db: TestDatabase;
const rows = (sql: string, params: unknown[] = []) =>
  withAdminClient(env, db.name, async (client) => (await client.query(sql, params)).rows);
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());

// Every definer of the publish and disconnect work: owned by the definer role, a pinned search path, and no EXECUTE for
// PUBLIC.
const DEFINERS = [
  "post_schedule",
  "post_unschedule",
  "post_publish_now",
  "post_edit",
  "post_delete",
  "notice_create",
  "notice_recipients",
  "notice_candidates",
  "notice_escalation_advance",
  "user_locale_set",
  "channel_disconnect",
  "credential_destroy",
  "credential_open_revoking",
  "credentials_revoking_stale",
];

describe("the definers of publishing and disconnect", () => {
  it.each(DEFINERS)("%s is owned by shoutory_definer, pins search_path and refuses PUBLIC", async (name) => {
    const found = await rows(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
         coalesce(array_to_string(p.proconfig, ','), '') AS config,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = $1`,
      [name],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ owner: "shoutory_definer", definer: true, public_execute: false });
    expect(found[0]?.config).toContain("search_path=");
  });
});

describe("the notifications table", () => {
  it("has row security enabled and forced, and the app role cannot write it", async () => {
    const [table] = await rows(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
         has_table_privilege('shoutory_app', c.oid, 'INSERT') AS app_insert,
         has_table_privilege('shoutory_app', c.oid, 'UPDATE') AS app_update,
         has_table_privilege('shoutory_app', c.oid, 'DELETE') AS app_delete,
         has_table_privilege('shoutory_app', c.oid, 'SELECT') AS app_select
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relname = 'notifications'`,
    );
    expect(table).toEqual({
      enabled: true,
      forced: true,
      app_insert: false,
      app_update: false,
      app_delete: false,
      app_select: true,
    });
  });
});
