import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, digestOf, OA, seedMembers, U } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);
const EDITOR = asUser(U.editor);

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(seedMembers);
});
afterAll(() => db.drop());

// Each test takes a fresh workspace of organization A, so its byte total is only what the test plants.
async function workspace(): Promise<string> {
  const id = randomUUID();
  await rows("INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, $3, $3)", [
    id,
    OA,
    `cap-${id}`,
  ]);
  await rows(
    `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
     VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner')),
       ($1, $3, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'editor'))`,
    [id, U.owner, U.editor],
  );
  return id;
}

interface Planted {
  state: string;
  bytes?: number;
  /** The size a pending upload declared; `null` plants an upload session from before sizes were declared. */
  declared?: number | null;
  removed?: boolean;
  derivative?: { state: string; bytes: number };
}
async function plant(ws: string, o: Planted): Promise<string> {
  const id = randomUUID();
  const pending = o.state === "pending_upload";
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256,
       byte_size, deleted_at, object_removed_at)
     VALUES ($1, $2, $3, 'cap.png', 'upload', $4, $5, $6, $7,
       CASE WHEN $5 = 'deleted' THEN now() END, CASE WHEN $8 THEN now() END)`,
    [
      id,
      ws,
      `ws/${ws}/${id}/1/original`,
      U.editor,
      o.state,
      pending ? null : digestOf(id),
      o.bytes ?? null,
      !!o.removed,
    ],
  );
  if (pending || o.declared !== undefined)
    await rows(
      `INSERT INTO app.media_uploads (workspace_id, media_id, expires_at, declared_size)
       VALUES ($1, $2, now() + interval '1 day', $3)`,
      [ws, id, o.declared ?? null],
    );
  if (o.derivative)
    await rows(
      `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, byte_size)
       VALUES ($1, $2, 'thumb', $3, $4, $5)`,
      [ws, id, `ws/${ws}/${id}/1/thumb`, o.derivative.state, o.derivative.bytes],
    );
  return id;
}

const register = (ws: string, declared: number | null, cap: number | null): [string, unknown[]] => [
  "SELECT app.media_register($1, 'cap.png', 'image/png', 'upload', NULL, NULL, NULL, $2, $3) AS id",
  [ws, declared, cap],
];
const run = (ctx: TenantCtx, [sql, params]: [string, unknown[]]) => attempt(db.pool("app"), ctx, sql, params);
const refusalOf = async (call: [string, unknown[]]) => {
  const { error } = await run(EDITOR, call);
  return error === undefined ? "passed" : (error as { code?: string; message?: string });
};
const STORAGE_FULL = { code: "SH422", message: "media_register: storage_full" };

const COUNTED: [string, Planted, boolean][] = [
  ["an uploaded original", { state: "uploaded", bytes: 1000 }, true],
  ["a scanning original", { state: "scanning", bytes: 1000 }, true],
  ["a processing original", { state: "processing", bytes: 1000 }, true],
  ["a ready original", { state: "ready", bytes: 1000 }, true],
  ["a ready derivative", { state: "ready", bytes: 1, derivative: { state: "ready", bytes: 1000 } }, true],
  ["the size a pending upload declared", { state: "pending_upload", declared: 1000 }, true],
  ["a deleted original still on disk", { state: "deleted", bytes: 1000 }, true],
  ["a deleted duplicate still on disk with no stored size", { state: "deleted", declared: 1000 }, true],
  ["a deleted original already removed", { state: "deleted", bytes: 1000, removed: true }, false],
  ["a rejected original", { state: "rejected", bytes: 1000 }, false],
  ["a failed derivative", { state: "ready", bytes: 1, derivative: { state: "failed", bytes: 1000 } }, false],
  ["a pending upload that declared no size", { state: "pending_upload", declared: null }, false],
];

describe("a register past the workspace byte cap is refused (security floor)", () => {
  const rowsOf = COUNTED.map(([what, planted, counted]): [string, Planted, boolean] => [
    `${what} ${counted ? "counts" : "does not count"} toward the cap`,
    planted,
    counted,
  ]);
  it.each(rowsOf)("%s", async (_title, planted, counted) => {
    const ws = await workspace();
    await plant(ws, planted);
    // 999 bytes fit under the cap alone and pass it with any 1000 bytes counted beside them.
    const answer = await refusalOf(register(ws, 999, 1998));
    expect(answer).toEqual(counted ? expect.objectContaining(STORAGE_FULL) : "passed");
  });

  it("passes a register that reaches the cap exactly and refuses one byte more", async () => {
    const [exact, over] = [await workspace(), await workspace()];
    await plant(exact, { state: "ready", bytes: 600 });
    await plant(over, { state: "ready", bytes: 600 });
    expect(await refusalOf(register(exact, 400, 1000))).toBe("passed");
    expect(await refusalOf(register(over, 401, 1000))).toMatchObject(STORAGE_FULL);
  });

  it("never refuses for size when no cap is set", async () => {
    const ws = await workspace();
    await plant(ws, { state: "ready", bytes: 5 * 1024 ** 3 });
    expect(await refusalOf(register(ws, 5 * 1024 ** 3, null))).toBe("passed");
  });

  it("refuses a declared size outside 1 byte to 5 GiB (22023)", async () => {
    const ws = await workspace();
    for (const declared of [null, 0, 5 * 1024 ** 3 + 1])
      expect(await refusalOf(register(ws, declared, null))).toMatchObject({ code: "22023" });
  });

  it("counts only its own workspace, and its refusal names no number", async () => {
    const [mine, other] = [await workspace(), await workspace()];
    await plant(other, { state: "ready", bytes: 5000 });
    await plant(other, { state: "ready", bytes: 1, derivative: { state: "ready", bytes: 5000 } });
    await plant(other, { state: "pending_upload", declared: 5000 });
    expect(await refusalOf(register(mine, 1000, 1000))).toBe("passed");
    const refused = await refusalOf(register(other, 1, 1000));
    expect(refused).toMatchObject(STORAGE_FULL);
    expect(refused === "passed" ? "" : refused.message).not.toMatch(/\d/);
  });
});

describe("two registers racing for the last bytes (security floor)", () => {
  // The workspace row is locked before the sum, so two callers cannot both take the last bytes.
  it("two callers registering the last bytes at once end with one refused", async () => {
    const ws = await workspace();
    await plant(ws, { state: "ready", bytes: 600 });
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("app"), EDITOR),
      await openTx(db.pool("app"), EDITOR),
      async (client) => {
        const [sql, params] = register(ws, 300, 1000);
        await client.query(sql, params);
      },
    );
    expect(result.secondError).toMatchObject(STORAGE_FULL);
  }, 30_000);
});

const markUploaded = (ws: string, asset: string, size: number): [string, unknown[]] => [
  "SELECT * FROM app.media_mark_uploaded($1, $2, $3, $4, 'image/png')",
  [ws, asset, digestOf(`mark-${asset}`), size],
];

describe("an upload cannot be larger than the size it was registered with (security floor)", () => {
  it.each([
    ["one byte more than declared", 1000, 1001, { code: "SH422", message: "media_mark_uploaded: too_large" }],
    ["exactly the declared size", 1000, 1000, "passed"],
    ["less than declared", 1000, 10, "passed"],
    ["any size for an upload that declared none", null, 5000, "passed"],
  ] as const)("marking %s", async (_what, declared, size, expected) => {
    const ws = await workspace();
    const asset = await plant(ws, { state: "pending_upload", declared });
    const answer = await refusalOf(markUploaded(ws, asset, size));
    expect(answer).toEqual(expected === "passed" ? "passed" : expect.objectContaining(expected));
  });
});

describe("what media_register may read (grants pin)", () => {
  it("holds exactly the purpose policies the count and the insert need", async () => {
    const policies = await rows(
      `SELECT p.polname || ' on ' || c.relname AS policy FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'app'::regnamespace AND p.polname LIKE 'media\\_register\\_%'`,
    );
    expect(policies.map((row) => row.policy as string).sort()).toEqual(
      [
        "media_register_insert on media_assets",
        "media_register_insert on media_uploads",
        "media_register_select on media_assets",
        "media_register_select on media_derivatives",
        "media_register_select on media_uploads",
        "media_register_select on organization_members",
        "media_register_select on roles",
        "media_register_select on workspace_members",
        "media_register_select on workspaces",
        "media_register_update on workspaces",
      ].sort(),
    );
  });
});
