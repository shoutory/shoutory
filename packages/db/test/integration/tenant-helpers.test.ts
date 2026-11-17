import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { cloneTemplate, readTestEnv, type TestDatabase } from "../../src/testing/template.js";

const env = readTestEnv();

// Security floor: a helper that reads a missing, empty or malformed setting must answer NULL (or an empty array),
// never an error and never a wider value. Settings are planted raw: withTenant would refuse most of these.
const ID = randomUUID();
const ID2 = randomUUID();
const manyIds = (n: number) => Array.from({ length: n }, () => randomUUID());

// Rows: [helper, setting, raw value (undefined = never set), expected answer].
const UUID_SCALARS = [
  ["org", "app.organization_id"],
  ["write_ws", "app.write_workspace_id"],
  ["principal_id", "app.principal_id"],
  ["portal_grant_id", "app.portal_grant_id"],
] as const;
const BAD_UUIDS: [string, string | undefined][] = [
  ["a missing setting", undefined],
  ["an empty value", ""],
  ["text that is not a uuid", "not-a-uuid"],
  ["an upper-case uuid", ID.toUpperCase()],
  ["a uuid with a trailing space", `${ID} `],
  ["a uuid in braces", `{${ID}}`],
];
const SCALAR_ROWS: [string, string, string | undefined, string | null][] = [
  ...UUID_SCALARS.flatMap(([helper, setting]) => [
    [helper, setting, ID, ID] as [string, string, string | undefined, string | null],
    ...BAD_UUIDS.map(
      ([, value]) => [helper, setting, value, null] as [string, string, string | undefined, string | null],
    ),
  ]),
  ...["user", "service", "job", "portal"].map(
    (v) => ["principal_kind", "app.principal_kind", v, v] as [string, string, string, string],
  ),
  ...[undefined, "", "Portal", "portal ", "admin"].map(
    (v) => ["principal_kind", "app.principal_kind", v, null] as [string, string, string | undefined, null],
  ),
  ...["api_key", "oauth_client", "agent_runner"].map(
    (v) => ["service_kind", "app.service_kind", v, v] as [string, string, string, string],
  ),
  ...[undefined, "", "API_KEY", "key"].map(
    (v) => ["service_kind", "app.service_kind", v, null] as [string, string, string | undefined, null],
  ),
  ["job_purpose", "app.job_purpose", `o'brien "x"`, `o'brien "x"`],
  ["job_purpose", "app.job_purpose", undefined, null],
  ["job_purpose", "app.job_purpose", "", null],
];

// The last column is the expected array, or the expected length for the 500-entry boundary row.
const ARRAY_ROWS: [string, string | undefined, string[] | number][] = [
  ["a missing setting", undefined, []],
  ["an empty value", "", []],
  ["an empty array", "{}", []],
  ["two valid uuids", `{${ID},${ID2}}`, [ID, ID2]],
  ["500 valid uuids (the cap)", `{${manyIds(500).join(",")}}`, 500],
  ["one bad element among valid uuids", `{${ID},not-a-uuid,${ID2}}`, []],
  ["upper case", `{${ID.toUpperCase()}}`, []],
  ["whitespace after a comma", `{${ID}, ${ID2}}`, []],
  ["wrong braces: brackets", `[${ID}]`, []],
  ["wrong braces: parentheses", `(${ID})`, []],
  ["no braces", `${ID},${ID2}`, []],
  ["a missing closing brace", `{${ID}`, []],
  ["a quoted element", `{"${ID}"}`, []],
  ["501 valid uuids (over the cap)", `{${manyIds(501).join(",")}}`, []],
];

describe("tenant setting helpers", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await cloneTemplate(env, inject("shoutoryTemplate"));
  });
  afterAll(() => db.drop());

  async function answer(sql: string, setting: string, value: string | undefined): Promise<unknown> {
    const client = await db.pool("app").connect();
    try {
      await client.query("BEGIN");
      if (value !== undefined) await client.query("SELECT set_config($1, $2, true)", [setting, value]);
      const result = await client.query(`SELECT ${sql} AS v`);
      await client.query("ROLLBACK");
      return result.rows[0].v;
    } finally {
      client.release();
    }
  }

  it.each(SCALAR_ROWS)("app.%s() reads %s=%j as %j", async (helper, setting, value, expected) => {
    expect(await answer(`app.${helper}()::text`, setting, value)).toBe(expected);
  });

  it.each(ARRAY_ROWS)("app.ws_ids() for %s", async (_title, value, expected) => {
    const got = (await answer("app.ws_ids()::text[]", "app.workspace_ids", value)) as string[];
    if (typeof expected === "number") expect(got).toHaveLength(expected);
    else expect(got).toEqual(expected);
  });
});
