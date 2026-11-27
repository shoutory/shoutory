import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, seedMembers, U, WA } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();
let db: TestDatabase;
const rows = (sql: string, params: unknown[] = []) =>
  withAdminClient(env, db.name, async (client) => (await client.query(sql, params)).rows);

const JOB: TenantCtx = { principalKind: "job", principalId: randomUUID(), workspaceIds: [] };
const SERVICE: TenantCtx = {
  principalKind: "service",
  serviceKind: "api_key",
  principalId: randomUUID(),
  writeWorkspaceId: randomUUID(),
  workspaceIds: [],
};
const PORTAL: TenantCtx = { principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [] };

const sealed = (key = "k1") => [
  1,
  key,
  randomBytes(12),
  randomBytes(48),
  randomBytes(16),
  randomBytes(12),
  randomBytes(16),
  randomBytes(48),
];
const ENSURE =
  "SELECT * FROM app.provider_app_ensure($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)";
const candidate = (provider: string, clientId: string) => [
  randomUUID(),
  provider,
  clientId,
  `https://app.example.test/api/v1/provider-documents/${provider}/client-metadata.json`,
  ...sealed(),
];
const lookup = (provider: string) => [
  null,
  provider,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];

// A user names the workspace the call is made from; a job names none.
async function run(
  pool: "app" | "worker",
  ctx: TenantCtx,
  params: unknown[],
  workspace: string | null = ctx.principalKind === "user" ? WA : null,
) {
  const client = await openTx(db.pool(pool), ctx);
  try {
    const result = (await client.query(ENSURE, [workspace, ...params])).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await withAdminClient(env, db.name, (client) => seedMembers(client));
});
afterAll(() => db.drop());

describe("provider_app_ensure", () => {
  it("lets the first writer of a provider win and answers the winner to a later candidate", async () => {
    const provider = `ensure-${randomUUID()}`;
    const first = candidate(provider, "client-first");
    const second = candidate(provider, "client-second");
    const won = await run("app", asUser(U.admin), first);
    const lost = await run("worker", JOB, second);
    expect(won).toMatchObject([{ id: first[0], client_id: "client-first", generation: 1 }]);
    expect(lost).toMatchObject([{ id: first[0], client_id: "client-first", generation: 1 }]);
    expect(
      await rows("SELECT count(*)::int AS n FROM app.provider_apps WHERE provider_id = $1", [provider]),
    ).toEqual([{ n: 1 }]);
  });

  it("answers no row to a read before an app exists and the row after", async () => {
    const provider = `lookup-${randomUUID()}`;
    expect(await run("worker", JOB, lookup(provider))).toEqual([]);
    const made = candidate(provider, "client-read");
    await run("app", asUser(U.admin), made);
    expect(await run("worker", JOB, lookup(provider))).toMatchObject([
      { id: made[0], client_id: "client-read" },
    ]);
  });

  it.each([
    ["a service principal", SERVICE, WA],
    ["a portal principal", PORTAL, WA],
    ["a Viewer of the workspace", asUser(U.viewer), WA],
    ["an Editor of the workspace", asUser(U.editor), WA],
    ["an Admin of another workspace", asUser(U.bOwner), WA],
    ["an Admin naming no workspace", asUser(U.admin), null],
  ])("refuses %s (42501), for a candidate and for a read", async (_name, ctx, workspace) => {
    const provider = `refused-${randomUUID()}`;
    for (const params of [candidate(provider, "c"), lookup(provider)]) {
      const outcome = await attempt(db.pool("app"), ctx, ENSURE, [workspace, ...params]);
      expect(outcome.error).toMatchObject({ code: "42501" });
    }
    expect(await rows("SELECT 1 FROM app.provider_apps WHERE provider_id = $1", [provider])).toEqual([]);
  });
});

describe("provider_apps_reseal", () => {
  it("lists a row under another key and moves it once, by generation", async () => {
    const provider = `reseal-${randomUUID()}`;
    const made = candidate(provider, "client-reseal");
    await run("app", asUser(U.admin), made);
    const asWorker = async (sql: string, params: unknown[] = []) => {
      const client = await openTx(db.pool("worker"), JOB);
      try {
        const result = (await client.query(sql, params)).rows;
        await client.query("COMMIT");
        return result;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const listed = await asWorker("SELECT * FROM app.provider_apps_reseal_batch(100, 'k2', NULL)");
    expect(listed.map((row) => row.id)).toContain(made[0]);
    const WRITE = "SELECT app.provider_apps_reseal_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS written";
    const next = sealed("k2");
    const args = [made[0], 1, next[3], next[2], next[4], next[5], next[6], next[7], "k2", 1];
    expect(await asWorker(WRITE, args)).toEqual([{ written: true }]);
    expect(await asWorker(WRITE, args)).toEqual([{ written: false }]);
    expect(
      await rows("SELECT secret_generation, secret_key_id FROM app.provider_apps WHERE id = $1", [made[0]]),
    ).toEqual([{ secret_generation: 2, secret_key_id: "k2" }]);
  });
});
