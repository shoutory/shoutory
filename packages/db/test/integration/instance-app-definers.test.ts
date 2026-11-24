import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, commitAs, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Security floor of the per-instance app of a provider whose accounts live on user-chosen servers: the app's client
// secret is one sealed object in `provider_instance_apps`, a table no runtime role can touch, written and read by two
// definers. `instance_app_put` stores the row the caller sealed under that row's own id and answers whether the stored
// row is the caller's: a second first-writer of one (provider, host) loses without an error, and a replace names the
// client id it replaces, so a late replace never overwrites a newer app (compare-and-set). Both definers are for a
// signed-in Admin of the workspace named in the call, never a job or a service. The argument lists, the boolean answer
// of `put` and the columns of `get` are the contract the migration must meet. Rows are planted and read as the superuser.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const PROVIDER = "fixture_oauth";
const sealed = () => [
  1,
  "k1",
  randomBytes(12),
  randomBytes(48),
  randomBytes(16),
  randomBytes(12),
  randomBytes(16),
  randomBytes(48),
];
const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const SERVICE: TenantCtx = {
  principalKind: "service",
  serviceKind: "api_key",
  principalId: randomUUID(),
  workspaceIds: [WA],
  writeWorkspaceId: WA,
};
const hostOf = () => `social-${randomUUID().slice(0, 8)}.example`;

interface Put {
  id?: string;
  ws?: string;
  host: string;
  clientId?: string;
  seal?: ReturnType<typeof sealed>;
  replaces?: string | null;
}
const PUT =
  "SELECT app.instance_app_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS stored";
const putCall = (o: Put): [string, unknown[]] => [
  PUT,
  [
    o.id ?? randomUUID(),
    o.ws ?? WA,
    PROVIDER,
    o.host,
    o.clientId ?? `client-${randomUUID()}`,
    ...(o.seal ?? sealed()),
    o.replaces ?? null,
  ],
];
const GET = "SELECT * FROM app.instance_app_get($1, $2, $3)";
const getAs = (ctx: TenantCtx, host: string, ws: string = WA) =>
  attempt(db.pool("app"), ctx, GET, [ws, PROVIDER, host]);
const storedOf = (host: string) =>
  rows(
    "SELECT id, client_id, secret_ciphertext, secret_generation FROM app.provider_instance_apps WHERE provider_id = $1 AND instance_host = $2",
    [PROVIDER, host],
  );

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin((client) => seedMembers(client));
});
afterAll(() => db.drop());

describe("instance_app_put and instance_app_get (floor)", () => {
  it("stores the sealed app under the id the caller chose and reads it back whole for an Admin of the workspace", async () => {
    const host = hostOf();
    const [id, seal, clientId] = [randomUUID(), sealed(), "client-roundtrip-1"];
    const [made] = await commitAs(db.pool("app"), U.admin, ...putCall({ id, host, seal, clientId }));
    expect(made?.stored).toBe(true);
    expect(await storedOf(host)).toMatchObject([{ id, client_id: clientId, secret_generation: 1 }]);
    const read = await getAs(asUser(U.admin2), host);
    expect(read.error).toBeUndefined();
    expect(read.rows).toMatchObject([{ id, client_id: clientId, ciphertext: seal[3], wrapped_dek: seal[7] }]);
  });

  it("answers no row for an instance with no app", async () => {
    expect((await getAs(asUser(U.admin), hostOf())).rows).toEqual([]);
  });

  it.each([
    ["an Editor of the workspace", asUser(U.editor), WA],
    ["an Admin of another workspace", asUser(U.bOwner), WA],
    ["an Admin asking with another workspace", asUser(U.admin), WB],
    ["a job principal", job([WA]), WA],
    ["a service principal", SERVICE, WA],
  ] as [string, TenantCtx, string][])(
    "%s can neither put nor get an app (42501) and nothing is written",
    async (_who, ctx, ws) => {
      const host = hostOf();
      await commitAs(db.pool("app"), U.admin, ...putCall({ host }));
      const [sql, params] = putCall({ host: hostOf(), ws });
      expect((await attempt(db.pool("app"), ctx, sql, params)).error).toMatchObject({ code: "42501" });
      expect((await getAs(ctx, host, ws)).error).toMatchObject({ code: "42501" });
      expect(
        await rows("SELECT 1 FROM app.provider_instance_apps WHERE instance_host = $1", [params[3]]),
      ).toEqual([]);
    },
  );

  it("after a put, neither the app nor the worker role can read or change the stored app directly", async () => {
    const host = hostOf();
    await commitAs(db.pool("app"), U.admin, ...putCall({ host }));
    expect(await storedOf(host)).toHaveLength(1);
    const direct = [
      "SELECT count(*) FROM app.provider_instance_apps",
      "UPDATE app.provider_instance_apps SET client_id = 'taken-over'",
      "DELETE FROM app.provider_instance_apps",
      `INSERT INTO app.provider_instance_apps (provider_id, instance_host, client_id, secret_ciphertext, secret_iv,
         secret_auth_tag, secret_wrap_iv, secret_wrap_tag, secret_wrapped_dek, secret_key_id, secret_format_version,
         secret_generation)
       VALUES ('${PROVIDER}', 'direct.example', 'c', '\\x00', '\\x00', '\\x00', '\\x00', '\\x00', '\\x00', 'k1', 1, 1)`,
    ];
    for (const [role, ctx] of [
      ["app", asUser(U.admin)],
      ["worker", job([WA])],
    ] as [string, TenantCtx][]) {
      for (const sql of direct) {
        const done = await attempt(db.pool(role as "app" | "worker"), ctx, sql);
        expect(done.error, `${role}: ${sql.slice(0, 30)}`).toMatchObject({ code: "42501" });
      }
    }
    expect((await storedOf(host))[0]?.client_id).toMatch(/^client-/);
  });
});

describe("instance_app_put: the first writer wins and a replace is compare-and-set (floor)", () => {
  it("a second app for one provider and host is not stored and leaves the first untouched", async () => {
    const host = hostOf();
    const [first] = await commitAs(db.pool("app"), U.admin, ...putCall({ host, clientId: "client-first" }));
    const [second] = await commitAs(
      db.pool("app"),
      U.admin2,
      ...putCall({ host, clientId: "client-second" }),
    );
    expect([first?.stored, second?.stored]).toEqual([true, false]);
    expect(await storedOf(host)).toMatchObject([{ client_id: "client-first" }]);
  });

  it("two first connects at once leave one stored app: the loser waits on the winner, is told it lost and writes nothing", async () => {
    const host = hostOf();
    const [one, two] = [
      await openTx(db.pool("app"), asUser(U.admin)),
      await openTx(db.pool("app"), asUser(U.admin2)),
    ];
    const answers: unknown[] = [];
    const outcome = await holdThenRace(
      rows,
      one,
      two,
      async (client, n) => {
        const [sql, params] = putCall({ host, clientId: `client-race-${n}` });
        answers.push((await client.query(sql, params)).rows[0]?.stored);
      },
      3_000,
    );
    expect(outcome.secondError).toBeUndefined();
    expect(answers).toEqual([true, false]);
    expect(await storedOf(host)).toMatchObject([{ client_id: "client-race-1" }]);
  });
});

describe("instance_app_put: a replace is compare-and-set on the client id (floor)", () => {
  it("a replace that names the stored client id stores the new app under its new id", async () => {
    const host = hostOf();
    await commitAs(db.pool("app"), U.admin, ...putCall({ host, clientId: "client-old" }));
    const fresh = randomUUID();
    const [done] = await commitAs(
      db.pool("app"),
      U.admin,
      ...putCall({ id: fresh, host, clientId: "client-new", replaces: "client-old" }),
    );
    expect(done?.stored).toBe(true);
    expect(await storedOf(host)).toMatchObject([{ id: fresh, client_id: "client-new" }]);
  });

  it("a replace that names a client id that is no longer stored is not stored and the newer app stays", async () => {
    const host = hostOf();
    await commitAs(db.pool("app"), U.admin, ...putCall({ host, clientId: "client-old" }));
    await commitAs(
      db.pool("app"),
      U.admin,
      ...putCall({ host, clientId: "client-newer", replaces: "client-old" }),
    );
    const [late] = await commitAs(
      db.pool("app"),
      U.admin2,
      ...putCall({ host, clientId: "client-late", replaces: "client-old" }),
    );
    expect(late?.stored).toBe(false);
    expect(await storedOf(host)).toMatchObject([{ client_id: "client-newer" }]);
  });

  // One policy per purpose, table and command: the app table is written and read only under these two purposes, and the
  // permission check reads the tenancy tables under the same two.
  it("the policies on the app table and of its two purposes are exactly these", async () => {
    const found = await rows(
      `SELECT p.polname || ' on ' || c.relname AS policy FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'app'::regnamespace
         AND (c.relname = 'provider_instance_apps' OR p.polname LIKE 'instance\\_app\\_%')`,
    );
    const tenancy = ["workspaces", "workspace_members", "organization_members", "roles"];
    expect(found.map((row) => row.policy as string).sort()).toEqual(
      [
        "provider_instance_apps_deny_runtime on provider_instance_apps",
        "instance_app_get_select on provider_instance_apps",
        "instance_app_put_select on provider_instance_apps",
        "instance_app_put_insert on provider_instance_apps",
        "instance_app_put_delete on provider_instance_apps",
        ...tenancy.flatMap((table) => [
          `instance_app_get_select on ${table}`,
          `instance_app_put_select on ${table}`,
        ]),
      ].sort(),
    );
  });
});

// An app stored or replaced on an instance is a change of what every workspace of that instance connects through, so it
// is audited in the workspace of the caller, with the provider and the host and no secret. A put that lost writes nothing.
describe("instance_app_put audits what it changes (floor)", () => {
  const auditOf = (id: string) =>
    rows(
      "SELECT action, workspace_id, metadata FROM app.audit_logs WHERE resource_kind = 'instance_app' AND resource_id = $1",
      [id],
    );

  it("appends one row for a stored app and one for a replaced app, and none for a put that lost", async () => {
    const host = hostOf();
    const [stored, replaced, lost] = [randomUUID(), randomUUID(), randomUUID()];
    await commitAs(db.pool("app"), U.admin, ...putCall({ id: stored, host, clientId: "client-audit-1" }));
    await commitAs(
      db.pool("app"),
      U.admin,
      ...putCall({ id: replaced, host, clientId: "client-audit-2", replaces: "client-audit-1" }),
    );
    await commitAs(db.pool("app"), U.admin, ...putCall({ id: lost, host, clientId: "client-audit-3" }));
    const metadata = { provider_id: PROVIDER, instance_host: host };
    expect(await auditOf(stored)).toEqual([{ action: "instance.app_stored", workspace_id: WA, metadata }]);
    expect(await auditOf(replaced)).toEqual([
      { action: "instance.app_replaced", workspace_id: WA, metadata },
    ]);
    expect(await auditOf(lost)).toEqual([]);
  });
});
