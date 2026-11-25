import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

let channel: string;
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    channel = (
      await client.query(
        `INSERT INTO app.channels (workspace_id, provider_id, account_kind, provider_account_id, display_name)
         VALUES ($1, 'fixture-oauth', 'profile', 'gc-channel', 'gc-channel') RETURNING id`,
        [WA],
      )
    ).rows[0].id;
  });
});
afterAll(() => db.drop());

const job = (workspaces: string[]): TenantCtx => ({
  principalKind: "job",
  principalId: randomUUID(),
  workspaceIds: workspaces,
});
const SYSTEM_JOB: TenantCtx = { principalKind: "job", principalId: randomUUID(), jobPurpose: "maintenance" };
const SERVICE: TenantCtx = {
  principalKind: "service",
  serviceKind: "api_key",
  principalId: randomUUID(),
  workspaceIds: [WA],
  writeWorkspaceId: WA,
};
const PORTAL: TenantCtx = { principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [WA] };

interface Planted {
  id?: string;
  ws?: string;
  state?: string;
  ageDays?: number;
  deletedDays?: number;
  library?: boolean;
  removed?: boolean;
  // Days since a run found a ready asset unused; by default it has been unused since it was created.
  unreferencedDays?: number | null;
}
async function plantAsset(o: Planted = {}): Promise<string> {
  const id = o.id ?? randomUUID();
  const [ws, state] = [o.ws ?? WA, o.state ?? "ready"];
  const unreferenced = o.unreferencedDays === undefined ? (o.ageDays ?? 31) : o.unreferencedDays;
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256,
       created_at, in_library, deleted_at, object_removed_at, unreferenced_since)
     VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'gc.png', 'upload', $3::uuid, $4::text,
       CASE WHEN $4::text IN ('uploaded', 'scanning', 'processing', 'ready') THEN sha256(convert_to($1::text, 'UTF8')) END,
       now() - make_interval(secs => $5::float8 * 86400), $6,
       CASE WHEN $4::text = 'deleted' THEN now() - make_interval(secs => $7::float8 * 86400) END,
       CASE WHEN $8 THEN now() END,
       CASE WHEN $4::text = 'ready' AND $9::float8 IS NOT NULL
         THEN now() - make_interval(secs => $9::float8 * 86400) END)`,
    [
      id,
      ws,
      U.editor,
      state,
      o.ageDays ?? 31,
      o.library ?? false,
      o.deletedDays ?? 31,
      o.removed ?? false,
      unreferenced,
    ],
  );
  for (const profile of PROFILES) {
    await rows(
      `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, $3, 'ws/' || $1::text || '/' || $2::text || '/1/' || $3, 'ready',
         sha256(convert_to($2::text || $3, 'UTF8')), 5)`,
      [ws, id, profile],
    );
  }
  return id;
}
const PROFILES = ["small", "thumb"];
const keysOf = (ws: string, id: string) => [
  `ws/${ws}/${id}/1/original`,
  ...PROFILES.map((profile) => `ws/${ws}/${id}/1/${profile}`),
];
const stateOf = async (id: string) =>
  (await rows("SELECT state FROM app.media_assets WHERE id = $1", [id]))[0]?.state as string;
async function variantIn(): Promise<string> {
  const post = (
    await rows(
      "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
      [WA, U.editor],
    )
  )[0]?.id;
  return (
    await rows(
      "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, schedule_state) VALUES ($1, $2, $3, 'draft') RETURNING id",
      [WA, post, channel],
    )
  )[0]?.id as string;
}
const ATTACH =
  "INSERT INTO app.post_media (workspace_id, variant_id, position, media_id) VALUES ($1, $2, 0, $3)";
const attach = async (asset: string) => rows(ATTACH, [WA, await variantIn(), asset]);
// Triggers off, so the attach guard does not refuse a deleted asset a post still names.
async function attachUnchecked(asset: string): Promise<void> {
  const variant = await variantIn();
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(ATTACH, [WA, variant, asset]);
    await client.query("COMMIT");
  });
}

async function commit(ctx: TenantCtx, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const client = await openTx(db.pool(ctx.principalKind === "job" ? "worker" : "app"), ctx);
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const TAKE = "SELECT object_key FROM app.media_gc_take($1, $2, $3)";
const take = async (ctx: TenantCtx, ws: string, asset: string, arm: string) =>
  (await commit(ctx, TAKE, [ws, asset, arm])).map((row) => row.object_key as string);
const candidates = async (ctx: TenantCtx) =>
  (await commit(ctx, "SELECT workspace_id, asset_id, arm FROM app.media_gc_candidates(500)", [])) as {
    workspace_id: string;
    asset_id: string;
    arm: string;
  }[];

describe("media_gc_candidates reads every workspace for a job that holds none (floor)", () => {
  it("lists the assets of both workspaces for a job of no workspace, and only its own for a job of one", async () => {
    const [mine, theirs] = [await plantAsset({ ageDays: 31 }), await plantAsset({ ws: WB, ageDays: 31 })];
    const all = new Map((await candidates(SYSTEM_JOB)).map((row) => [row.asset_id, row.workspace_id]));
    expect([all.get(mine), all.get(theirs)]).toEqual([WA, WB]);
    const own = new Set((await candidates(job([WA]))).map((row) => row.asset_id));
    expect([own.has(mine), own.has(theirs)]).toEqual([true, false]);
  });

  it("lists only the assets after the cursor, in id order, and from the start for none", async () => {
    const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000010${n}`);
    for (const id of ids) await plantAsset({ id, ageDays: 31 });
    const after = async (cursor: string | null) =>
      (await commit(SYSTEM_JOB, "SELECT asset_id FROM app.media_gc_candidates(500, $1)", [cursor])).map(
        (row) => row.asset_id as string,
      );
    expect((await after(null)).filter((id) => ids.includes(id))).toEqual(ids);
    expect((await after(ids[0] as string)).filter((id) => ids.includes(id))).toEqual(ids.slice(1));
    expect(await after("ffffffff-ffff-4fff-bfff-ffffffffffff")).toEqual([]);
  });

  it("is refused to every principal that is not a job", async () => {
    for (const ctx of [asUser(U.owner), SERVICE, PORTAL]) {
      const answer = await attempt(db.pool("app"), ctx, "SELECT * FROM app.media_gc_candidates(10)");
      expect(answer.error).toMatchObject({ code: "42501" });
    }
  });
});

describe("what the candidate list offers beyond the 0019 rules", () => {
  const SCOPES: [string, TenantCtx][] = [
    ["a job of the workspace", job([WA])],
    ["a job of no workspace", SYSTEM_JOB],
  ];
  it.each(SCOPES)(
    "%s: the avatar of a workspace and a deleted asset a post names are not offered",
    async (_who, ctx) => {
      const avatar = await plantAsset({ ageDays: 40 });
      await rows("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [WA, avatar]);
      const named = await plantAsset({ state: "deleted", deletedDays: 40 });
      await attachUnchecked(named);
      const free = await plantAsset({ state: "deleted", deletedDays: 40 });
      const offered = new Set((await candidates(ctx)).map((row) => row.asset_id));
      expect([offered.has(avatar), offered.has(named), offered.has(free)]).toEqual([false, false, true]);
      await rows("UPDATE app.workspaces SET avatar = NULL WHERE id = $1", [WA]);
    },
  );

  it.each(SCOPES)(
    "%s: a rejected asset is offered 30 days after it was created, by the arm rejected",
    async (_who, ctx) => {
      const [old, young] = [
        await plantAsset({ state: "rejected", ageDays: 31 }),
        await plantAsset({ state: "rejected", ageDays: 29 }),
      ];
      const found = new Map((await candidates(ctx)).map((row) => [row.asset_id, row.arm]));
      expect([found.get(old), found.has(young)]).toEqual(["rejected", false]);
    },
  );
});

const TAKES: [string, Planted, string, boolean, string][] = [
  [
    "a pending upload 25 hours old",
    { state: "pending_upload", ageDays: 25 / 24 },
    "pending_upload",
    true,
    "deleted",
  ],
  [
    "a pending upload 23 hours old",
    { state: "pending_upload", ageDays: 23 / 24 },
    "pending_upload",
    false,
    "pending_upload",
  ],
  ["a ready asset 31 days old that nothing uses", { ageDays: 31 }, "unreferenced", true, "deleted"],
  ["a ready asset 29 days old", { ageDays: 29 }, "unreferenced", false, "ready"],
  ["a ready asset in the library", { ageDays: 31, library: true }, "unreferenced", false, "ready"],
  ["a rejected asset 31 days old", { state: "rejected", ageDays: 31 }, "rejected", true, "deleted"],
  ["a rejected asset 29 days old", { state: "rejected", ageDays: 29 }, "rejected", false, "rejected"],
  [
    "a deleted asset 31 days after its deletion",
    { state: "deleted", deletedDays: 31 },
    "deleted",
    true,
    "deleted",
  ],
  [
    "a deleted asset 29 days after its deletion",
    { state: "deleted", deletedDays: 29 },
    "deleted",
    false,
    "deleted",
  ],
  [
    "a deleted asset whose object is already removed",
    { state: "deleted", deletedDays: 31, removed: true },
    "deleted",
    false,
    "deleted",
  ],
  ["a ready asset, by the arm of pending uploads", { ageDays: 31 }, "pending_upload", false, "ready"],
  [
    "a pending upload, by the arm of unreferenced assets",
    { state: "pending_upload", ageDays: 31 },
    "unreferenced",
    false,
    "pending_upload",
  ],
];
describe("media_gc_take moves an asset to deleted only when its arm's rule holds at the take (floor)", () => {
  it.each(TAKES)("%s", async (_what, planted, arm, taken, after) => {
    const asset = await plantAsset(planted);
    expect(await take(job([WA]), WA, asset, arm)).toEqual(taken ? keysOf(WA, asset) : []);
    expect(await stateOf(asset)).toBe(after);
  });

  it("refuses an arm it does not know with 22023 and changes nothing", async () => {
    const asset = await plantAsset();
    const answer = await attempt(db.pool("worker"), job([WA]), TAKE, [WA, asset, "everything"]);
    expect(answer.error).toMatchObject({ code: "22023" });
    expect(await stateOf(asset)).toBe("ready");
  });

  it("leaves the object of a deleted asset to the job: taking the deleted arm answers its keys, moves nothing and stamps nothing", async () => {
    const asset = await plantAsset({ state: "deleted", deletedDays: 31 });
    expect(await take(job([WA]), WA, asset, "deleted")).toEqual(keysOf(WA, asset));
    expect((await rows("SELECT object_removed_at FROM app.media_assets WHERE id = $1", [asset]))[0]).toEqual({
      object_removed_at: null,
    });
  });
});

const MARK = "SELECT app.media_mark_unreferenced($1)";
const markRun = () => commit(SYSTEM_JOB, MARK, [500]);
const clockOf = async (id: string) =>
  (await rows("SELECT unreferenced_since FROM app.media_assets WHERE id = $1", [id]))[0]
    ?.unreferenced_since as Date | null;
async function pin(asset: string, state: string, unverifiedDays: number | null): Promise<void> {
  const variant = await variantIn();
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const op = await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, last_actor,
         due_at, lateness_deadline, idempotency_marker, requested_by, unverified_until)
       VALUES ($1, $2, $3, 'fixture-oauth', 'publish.pin', 'publish', $4, 'S', now(), now() + interval '2 hours', $5, $6,
         now() + make_interval(secs => $7::float8 * 86400)) RETURNING id`,
      [WA, variant, channel, state, `gc-pin-${randomUUID()}`, U.editor, unverifiedDays],
    );
    await client.query(
      `INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_sha256)
       VALUES ($1, $2, 0, $3, decode(repeat('ab', 32), 'hex'))`,
      [WA, op.rows[0].id, asset],
    );
    await client.query("COMMIT");
  });
}

describe("an unused medium is collected 30 days after its last reference, not after its upload", () => {
  it("an asset uploaded 31 days ago and unreferenced for 10 days is kept; at 30 days it is collected", async () => {
    const recent = await plantAsset({ ageDays: 31, unreferencedDays: 10 });
    const old = await plantAsset({ ageDays: 31, unreferencedDays: 30.01 });
    const offered = new Map((await candidates(job([WA]))).map((row) => [row.asset_id, row.arm]));
    expect([offered.has(recent), offered.get(old)]).toEqual([false, "unreferenced"]);
    expect(await take(job([WA]), WA, recent, "unreferenced")).toEqual([]);
    expect(await take(job([WA]), WA, old, "unreferenced")).toEqual(keysOf(WA, old));
  });
});

const CLOCK: [
  string,
  Planted,
  ((asset: string) => Promise<unknown>) | null,
  "set" | "cleared" | "unchanged",
][] = [
  ["a ready asset nothing uses", { unreferencedDays: null }, null, "set"],
  ["an attached asset", { unreferencedDays: 5 }, attach, "cleared"],
  ["an asset in the library", { library: true, unreferencedDays: 5 }, null, "cleared"],
  [
    "the workspace avatar",
    { unreferencedDays: 5 },
    (asset) => rows("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [WA, asset]),
    "cleared",
  ],
  [
    "an asset a live operation pins",
    { unreferencedDays: 5 },
    (asset) => pin(asset, "pending", null),
    "cleared",
  ],
  [
    "an asset pinned by a superseded operation past its window",
    { unreferencedDays: null },
    (asset) => pin(asset, "superseded_after_unknown_outcome", -1),
    "set",
  ],
  ["an asset already marked and still unused", { unreferencedDays: 5 }, null, "unchanged"],
  ["a rejected asset", { state: "rejected", unreferencedDays: null }, null, "unchanged"],
];
describe("a run starts the clock of a ready asset nothing needs and clears it on one that is needed", () => {
  afterEach(() => rows("UPDATE app.workspaces SET avatar = NULL WHERE id = $1", [WA]));
  it.each(CLOCK)(
    "a run over %s sets, clears or keeps its clock as the table says",
    async (_what, planted, become, expected) => {
      const asset = await plantAsset({ ageDays: 40, ...planted });
      await become?.(asset);
      const before = await clockOf(asset);
      const started = Date.now();
      await markRun();
      const after = await clockOf(asset);
      if (expected === "cleared") expect(after).toBeNull();
      if (expected === "unchanged") expect(after).toEqual(before);
      if (expected === "set") expect(after?.getTime()).toBeGreaterThanOrEqual(started - 5_000);
    },
  );
});

describe("a save that attaches a medium and a library flag clear its clock at once", () => {
  it("an attach and a detach between two runs restart the 30 days", async () => {
    const asset = await plantAsset({ ageDays: 40, unreferencedDays: 40 });
    const draft = (media: unknown[]) =>
      JSON.stringify({ draft: { variants: [{ channel_id: channel, locale: null, text: "gc", media }] } });
    const hash = (label: string) => createHash("sha256").update(label).digest();
    const [made] = await commit(asUser(U.editor), "SELECT * FROM app.post_create($1, $2::jsonb, $3)", [
      WA,
      draft([{ media_id: asset, alt_text: null, crop: null }]),
      hash("attached"),
    ]);
    expect(await clockOf(asset)).toBeNull();
    await commit(asUser(U.editor), "SELECT * FROM app.post_save($1, $2, $3, $4::jsonb, $5)", [
      WA,
      made?.post_id,
      made?.version_id,
      draft([]),
      hash("detached"),
    ]);
    await markRun();
    expect(await take(job([WA]), WA, asset, "unreferenced")).toEqual([]);
    expect(await stateOf(asset)).toBe("ready");
  });

  it("putting an asset in the library through its metadata clears its clock", async () => {
    const asset = await plantAsset({ ageDays: 40, unreferencedDays: 40 });
    await commit(asUser(U.editor), "SELECT app.media_set_metadata($1, $2, NULL, NULL, true)", [WA, asset]);
    expect(await clockOf(asset)).toBeNull();
  });
});

describe("who may run media_mark_unreferenced (floor)", () => {
  it.each([
    ["an Owner user", asUser(U.owner)],
    ["a service principal", SERVICE],
    ["a portal principal", PORTAL],
  ] as [string, TenantCtx][])("media_mark_unreferenced is refused to %s (floor)", async (_who, ctx) => {
    const asset = await plantAsset({ ageDays: 40, unreferencedDays: null });
    const answer = await attempt(db.pool("app"), ctx, MARK, [500]);
    expect(answer.error).toMatchObject({ code: "42501" });
    expect(await clockOf(asset)).toBeNull();
  });
});

describe("an asset that became needed after the list was read is not taken (race, floor)", () => {
  const BECAME: [string, (asset: string) => Promise<unknown>][] = [
    ["a post attached it", attach],
    [
      "it was put in the library",
      (asset) => rows("UPDATE app.media_assets SET in_library = true WHERE id = $1", [asset]),
    ],
    [
      "it became the avatar of its workspace",
      (asset) => rows("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [WA, asset]),
    ],
  ];
  it.each(BECAME)("%s between the list and the take", async (_what, become) => {
    const asset = await plantAsset({ ageDays: 40 });
    const listed = (await candidates(job([WA]))).find((row) => row.asset_id === asset);
    expect(listed?.arm).toBe("unreferenced");
    await become(asset);
    expect(await take(job([WA]), WA, asset, "unreferenced")).toEqual([]);
    expect(await stateOf(asset)).toBe("ready");
    await rows("UPDATE app.workspaces SET avatar = NULL WHERE id = $1", [WA]);
  });

  it("a take that meets an attach still uncommitted waits for it and then takes nothing", async () => {
    const asset = await plantAsset({ ageDays: 40 });
    const variant = await variantIn();
    const taken = await admin(async (writer) => {
      await writer.query("BEGIN");
      await writer.query(ATTACH, [WA, variant, asset]);
      const taking = openTx(db.pool("worker"), job([WA])).then(async (client) => {
        try {
          const found = (await client.query(TAKE, [WA, asset, "unreferenced"])).rows;
          await client.query("COMMIT");
          return found;
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });
      await untilSomeoneWaits();
      await writer.query("COMMIT");
      return taking;
    });
    expect(taken).toEqual([]);
    expect(await stateOf(asset)).toBe("ready");
  });
});

async function untilSomeoneWaits(): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    const waiting = await rows(
      `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted AND a.datname = $1`,
      [db.name],
    );
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("nobody waited for the lock");
}

describe("a post can name only a ready medium, whichever commits first (floor)", () => {
  const refused = (error: unknown) =>
    expect(error).toMatchObject({ code: "SH422", message: "post: media_unavailable" });

  it("an attach that commits after the take is refused, and writes no post_media", async () => {
    const asset = await plantAsset({ ageDays: 40 });
    expect(await take(job([WA]), WA, asset, "unreferenced")).toEqual(keysOf(WA, asset));
    const error = await attach(asset).catch((caught: unknown) => caught);
    refused(error);
    expect(await rows("SELECT 1 FROM app.post_media WHERE media_id = $1", [asset])).toEqual([]);
  });

  it("an attach that meets a take still uncommitted waits for it, is refused, and writes no post_media", async () => {
    const asset = await plantAsset({ ageDays: 40 });
    const variant = await variantIn();
    const holder = await openTx(db.pool("worker"), job([WA]));
    const error = await admin(async (writer) => {
      await holder.query(TAKE, [WA, asset, "unreferenced"]);
      const attaching = writer.query(ATTACH, [WA, variant, asset]).catch((caught: unknown) => caught);
      await untilSomeoneWaits();
      await holder.query("COMMIT");
      holder.release();
      return attaching;
    });
    refused(error);
    expect(await rows("SELECT 1 FROM app.post_media WHERE media_id = $1", [asset])).toEqual([]);
    expect(await stateOf(asset)).toBe("deleted");
  });

  it.each([
    ["a pending upload", { state: "pending_upload" }],
    ["a deleted asset", { state: "deleted" }],
    ["a rejected asset", { state: "rejected" }],
  ] as [string, Planted][])("%s is refused", async (_what, planted) => {
    const asset = await plantAsset(planted);
    refused(await attach(asset).catch((caught: unknown) => caught));
  });

  it("a ready medium is accepted, and a row of a medium that was collected since can still change its alt text", async () => {
    const asset = await plantAsset({ ageDays: 1 });
    await attach(asset);
    await rows("UPDATE app.media_assets SET state = 'deleted', deleted_at = now() WHERE id = $1", [asset]);
    await rows("UPDATE app.post_media SET alt_text = 'described' WHERE media_id = $1", [asset]);
    expect((await rows("SELECT alt_text FROM app.post_media WHERE media_id = $1", [asset]))[0]).toEqual({
      alt_text: "described",
    });
  });
});

describe("who may run media_gc_take (floor)", () => {
  const REFUSED: [string, TenantCtx][] = [
    ["an Owner user", asUser(U.owner)],
    ["an Admin user", asUser(U.admin)],
    ["an Editor user", asUser(U.editor)],
    ["a service principal", SERVICE],
    ["a portal principal", PORTAL],
    ["a job of another workspace", job([WB])],
    ["a job of no workspace", SYSTEM_JOB],
  ];
  it.each(REFUSED)("is refused to %s and changes nothing", async (_who, ctx) => {
    const asset = await plantAsset({ ageDays: 40 });
    const answer = await attempt(db.pool(ctx.principalKind === "job" ? "worker" : "app"), ctx, TAKE, [
      WA,
      asset,
      "unreferenced",
    ]);
    expect(answer.error).toMatchObject({ code: "42501" });
    expect(await stateOf(asset)).toBe("ready");
  });

  it("answers another workspace's asset and an id that exists nowhere with the same refusal", async () => {
    const foreign = await plantAsset({ ws: WB, ageDays: 40 });
    const asForeign = await attempt(db.pool("worker"), job([WA]), TAKE, [WA, foreign, "unreferenced"]);
    const asUnknown = await attempt(db.pool("worker"), job([WA]), TAKE, [WA, randomUUID(), "unreferenced"]);
    const asOtherWorkspace = await attempt(db.pool("worker"), job([WA]), TAKE, [WB, foreign, "unreferenced"]);
    for (const answer of [asForeign, asUnknown, asOtherWorkspace])
      expect(answer.error).toMatchObject({ code: "42501" });
    expect((asForeign.error as Error).message).toBe((asUnknown.error as Error).message);
    expect(await stateOf(foreign)).toBe("ready");
  });
});

describe("what the take and the candidate list may read and write (grants pin)", () => {
  it("holds exactly the purpose policies that the rule and the move need", async () => {
    const policies = await rows(
      `SELECT p.polname || ' on ' || c.relname AS policy FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'app'::regnamespace
         AND (p.polname LIKE 'media_gc_take\\_%' OR p.polname LIKE 'post_media_guard\\_%'
           OR p.polname LIKE 'media_mark_unreferenced\\_%' OR p.polname LIKE 'post_apply_draft\\_%'
           OR (p.polname LIKE 'media_gc_candidates\\_%' AND c.relname = 'workspaces'))`,
    );
    expect(policies.map((row) => row.policy as string).sort()).toEqual(
      [
        "media_gc_candidates_select on workspaces",
        "media_gc_take_select on media_derivatives",
        "post_media_guard_select on media_assets",
        "post_media_guard_update on media_assets",
        "media_gc_take_select on media_assets",
        "media_gc_take_select on operation_media",
        "media_gc_take_select on operations",
        "media_gc_take_select on post_media",
        "media_gc_take_select on workspaces",
        "media_gc_take_update on media_assets",
        "media_mark_unreferenced_select on media_assets",
        "media_mark_unreferenced_update on media_assets",
        "media_mark_unreferenced_select on operation_media",
        "media_mark_unreferenced_select on operations",
        "media_mark_unreferenced_select on post_media",
        "media_mark_unreferenced_select on workspaces",
        "post_apply_draft_select on media_assets",
        "post_apply_draft_update on media_assets",
      ].sort(),
    );
  });
});
