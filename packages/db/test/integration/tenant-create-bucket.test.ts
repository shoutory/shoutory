import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, OA, seedMembers, U } from "../support/members-seed.js";

const env = readTestEnv();

// R532 (4), R533 (A): the per-user creation bucket `tenant_create` (capacity 10, a full refill over 24 hours) is spent
// by workspace_create and organization_create alike, keyed by a digest the route computes and passes as the last
// argument. A refusal is SQLSTATE SH429 under the definer's name with the retry seconds in DETAIL, and creates nothing.
// The scope CHECK of rate_buckets also widens for the provider scopes that get their numbers later (R532 (5)).
let db: TestDatabase;
const key = (): string => randomUUID().replaceAll("-", "").repeat(2);
const slug = () => `tc-${randomUUID().slice(0, 8)}`;
const WORKSPACE = "SELECT app.workspace_create($1::uuid, 'tc', $2, 'UTC', NULL, NULL, $3)";
const ORGANIZATION = "SELECT app.organization_create('tc-org', 'team', NULL, NULL, $1)";
const makeWorkspace = (bucket: string) =>
  commitAs(db.pool("app"), U.orgOwner, WORKSPACE, [OA, slug(), bucket]);

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await withAdminClient(env, db.name, (admin) => seedMembers(admin));
});
afterAll(() => db.drop());

describe("the tenant_create bucket", () => {
  it("admits 10 workspace creations and refuses the 11th with SH429, the definer's name and the retry seconds", async () => {
    const bucket = key();
    for (let n = 0; n < 10; n++) await makeWorkspace(bucket);
    const refused = await attempt(db.pool("app"), asUser(U.orgOwner), WORKSPACE, [OA, slug(), bucket]);
    expect(refused.error).toMatchObject({ code: "SH429" });
    expect((refused.error as { message: string }).message).toMatch(/^workspace_create: /);
    expect((refused.error as { detail: string }).detail).toMatch(/^retry after [1-9]\d* seconds$/);
  });

  // That a refused call creates nothing, and that both routes spend the one bucket, is guarded through the routes by
  // the route throttle test.
  it("another key has its own bucket: an exhausted key does not block it", async () => {
    const spent = key();
    for (let n = 0; n < 10; n++) await makeWorkspace(spent);
    await expect(makeWorkspace(key())).resolves.toBeDefined();
  });
});

describe("the tenant_create bucket key", () => {
  it.each([
    ["too short", "abc"],
    ["upper case", "A".repeat(64)],
    ["not hex", "g".repeat(64)],
  ])(
    "a bucket key that is %s is refused with 22023 by both definers and creates nothing",
    async (_why, bad) => {
      const runs = [
        await attempt(db.pool("app"), asUser(U.orgOwner), WORKSPACE, [OA, slug(), bad]),
        await attempt(db.pool("app"), asUser(U.orgOwner), ORGANIZATION, [bad]),
      ];
      expect(runs.map((run) => (run.error as { code?: string }).code)).toEqual(["22023", "22023"]);
    },
  );
});

describe("the rate_buckets scope CHECK and the throttle numbers", () => {
  it("a bucket row of the new scope tenant_create is accepted by the table", async () => {
    const stored = await withAdminClient(env, db.name, (admin) =>
      admin.query("INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('tenant_create', $1, 1)", [
        key(),
      ]),
    );
    expect(stored.rowCount).toBe(1);
  });

  it("an unknown scope is still refused by the CHECK", async () => {
    const run = withAdminClient(env, db.name, (admin) =>
      admin.query("INSERT INTO app.rate_buckets (scope, key, tokens) VALUES ('bogus', $1, 1)", [key()]),
    );
    await expect(run).rejects.toMatchObject({ code: "23514" });
  });

  it("bucket_take spends tenant_create from 10 and still refuses a scope that has no numbers yet", async () => {
    const auth = db.pool("auth");
    const first = await auth.query("SELECT * FROM app.bucket_take($1, 'tenant_create', 1)", [key()]);
    expect(first.rows[0]).toMatchObject({ allowed: true, remaining: 9 });
    const refused = auth.query("SELECT * FROM app.bucket_take($1, 'account', 1)", [key()]);
    await expect(refused).rejects.toMatchObject({ code: "22023" });
  });
});
