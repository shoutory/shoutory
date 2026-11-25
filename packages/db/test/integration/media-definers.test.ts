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
import { asUser, attempt, digestOf, OA, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

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
const PORTAL: TenantCtx = { principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [WA] };
type Pool = "app" | "worker";
const poolOf = (ctx: TenantCtx): Pool => (ctx.principalKind === "job" ? "worker" : "app");

// Two more workspaces of organization A with the Editor: WC for the cap test, WD for every test that registers an
// asset, so the cap of 100 pending uploads never depends on how many assets the other rows plant in WA.
const WC = randomUUID();
const WD = randomUUID();
// WE is for the two-caller race at the cap, so nothing else registers in it.
const WE = randomUUID();

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    for (const [id, slug] of [
      [WC, "media-wc"],
      [WD, "media-wd"],
      [WE, "media-we"],
    ]) {
      await client.query(
        "INSERT INTO app.workspaces (id, organization_id, name, slug) VALUES ($1, $2, $3, $3)",
        [id, OA, slug],
      );
      // A workspace needs exactly one Owner; the Editor is the member the register rows act as.
      await client.query(
        `INSERT INTO app.workspace_members (workspace_id, user_id, role_id)
         VALUES ($1, $2, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'owner')),
           ($1, $3, (SELECT r.id FROM app.roles r WHERE r.workspace_id IS NULL AND r.key = 'editor'))`,
        [id, U.owner, U.editor],
      );
    }
  });
});
afterAll(() => db.drop());

interface Planted {
  ws?: string;
  state?: string;
  /** The digest; absent derives one from the id, `null` plants none. */
  sha?: Buffer | null;
  ageHours?: number;
  deletedDaysAgo?: number;
  removed?: boolean;
  session?: boolean;
}
async function plantAsset(o: Planted = {}): Promise<string> {
  const id = randomUUID();
  const ws = o.ws ?? WA;
  const state = o.state ?? "pending_upload";
  const sha = o.sha === undefined ? (state === "pending_upload" ? null : digestOf(id)) : o.sha;
  await rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256,
       created_at, deleted_at, object_removed_at)
     VALUES ($1, $2, $3, 'plant.png', 'upload', $4, $5, $6, now() - make_interval(hours => $7),
       CASE WHEN $5 = 'deleted' THEN now() - make_interval(days => $8) END,
       CASE WHEN $9 THEN now() END)`,
    [
      id,
      ws,
      `ws/${ws}/${id}/1/original`,
      U.editor,
      state,
      sha,
      o.ageHours ?? 0,
      o.deletedDaysAgo ?? 1,
      o.removed ?? false,
    ],
  );
  if (o.session) {
    await rows(
      "INSERT INTO app.media_uploads (workspace_id, media_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [ws, id],
    );
  }
  return id;
}
const plantPending = (ws: string, count: number) =>
  rows(
    `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by)
     SELECT g, $1::uuid, 'ws/' || $1 || '/' || g || '/1/original', 'cap.png', 'upload', $2::uuid
     FROM (SELECT uuidv7() AS g FROM generate_series(1, $3::int)) AS s`,
    [ws, U.editor, count],
  );
const assetOf = async (id: string) => (await rows("SELECT * FROM app.media_assets WHERE id = $1", [id]))[0];
const stateOf = async (id: string) => (await assetOf(id))?.state as string;

const call = (name: string, params: unknown[]): [string, unknown[]] => [
  `SELECT * FROM app.${name}(${params.map((_, index) => `$${index + 1}`).join(", ")})`,
  params,
];
const advance = (ws: string, asset: string, from: string, to: string, reason: string | null = null) =>
  call("media_advance", [ws, asset, from, to, reason, null]);
const markUploaded = (ws: string, asset: string, digest: Buffer) =>
  call("media_mark_uploaded", [ws, asset, digest, 1024, "image/png"]);
// The writers that answer one uuid are read as a column named `id`.
const scalar = (name: string, params: unknown[]): [string, unknown[]] => [
  `SELECT app.${name}(${params.map((_, index) => `$${index + 1}`).join(", ")}) AS id`,
  params,
];
const register = (ws = WD) =>
  scalar("media_register", [ws, "register.png", "image/png", "upload", null, null, null, 1024, null]);
const run = (ctx: TenantCtx, [sql, params]: [string, unknown[]]) =>
  attempt(db.pool(poolOf(ctx)), ctx, sql, params);
async function commit(
  ctx: TenantCtx,
  [sql, params]: [string, unknown[]],
): Promise<Record<string, unknown>[]> {
  const client = await openTx(db.pool(poolOf(ctx)), ctx);
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const EDITOR = asUser(U.editor);
const ADMIN = asUser(U.admin);

describe("a hash is unique per workspace among the live states", () => {
  const plant = (state: string, ws: string, sha: Buffer) =>
    plantAsset({ ws, state, sha }).catch((error) => error);
  it("refuses a second live asset, allows one after the first is deleted, and keeps the hash in another workspace", async () => {
    const sha = digestOf(`unique-${randomUUID()}`);
    const first = await plantAsset({ state: "ready", sha });
    expect(await plant("uploaded", WA, sha)).toMatchObject({ code: "23505" });
    // A rejected asset is not a live state, so it may carry the same hash.
    expect(typeof (await plant("rejected", WA, sha))).toBe("string");
    await rows("UPDATE app.media_assets SET state = 'deleted', deleted_at = now() WHERE id = $1", [first]);
    expect(typeof (await plant("ready", WA, sha))).toBe("string");
    expect(typeof (await plant("ready", WB, sha))).toBe("string");
  });
});

describe("media_mark_uploaded answers duplicate for a live hash and survives two callers at once", () => {
  it("answers duplicate with the live id and moves the new asset to deleted", async () => {
    const sha = digestOf(`duplicate-${randomUUID()}`);
    const live = await plantAsset({ state: "ready", sha });
    const fresh = await plantAsset();
    const [answer] = await commit(EDITOR, markUploaded(WA, fresh, sha));
    expect(answer).toMatchObject({ outcome: "duplicate", live_id: live });
    expect(await stateOf(fresh)).toBe("deleted");
  });

  it("two callers marking the same hash end with one uploaded and one duplicate, never a 23505", async () => {
    const sha = digestOf(`race-${randomUUID()}`);
    const [one, two] = [await plantAsset(), await plantAsset()];
    const answers: Record<number, Record<string, unknown> | undefined> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("app"), EDITOR),
      await openTx(db.pool("app"), EDITOR),
      async (client, n) => {
        const [sql, params] = markUploaded(WA, n === 1 ? one : two, sha);
        answers[n] = (await client.query(sql, params)).rows[0];
      },
    );
    expect(result.secondError).toBeUndefined();
    expect(answers[1]).toMatchObject({ outcome: "ok" });
    expect(answers[2]).toMatchObject({ outcome: "duplicate", live_id: one });
    expect([await stateOf(one), await stateOf(two)]).toEqual(["uploaded", "deleted"]);
  });
});

describe("an original's key and hash cannot change after upload (immutability trigger)", () => {
  it("a pending asset still gets its hash from mark-uploaded, so the guard is not vacuous", async () => {
    const sha = digestOf(`mark-${randomUUID()}`);
    const id = await plantAsset();
    const [answer] = await commit(EDITOR, markUploaded(WA, id, sha));
    expect(answer).toMatchObject({ outcome: "ok" });
    expect(await assetOf(id)).toMatchObject({ state: "uploaded", sha256: sha });
  });

  it.each([
    ["sha256", "sha256 = $2"],
    ["object_key", "object_key = $2"],
  ])(
    "an UPDATE by a superuser of %s on an uploaded asset is refused and changes nothing",
    async (column, set) => {
      const id = await plantAsset({ state: "uploaded" });
      const before = await assetOf(id);
      const value = column === "sha256" ? digestOf("changed") : `ws/${WA}/${id}/1/other`;
      await expect(
        rows(`UPDATE app.media_assets SET ${set} WHERE id = $1`, [id, value]),
      ).rejects.toBeDefined();
      expect(await assetOf(id)).toEqual(before);
      // The other columns stay writable, so the trigger guards exactly these two.
      await rows("UPDATE app.media_assets SET tags = ARRAY['kept'] WHERE id = $1", [id]);
      expect((await assetOf(id)).tags).toEqual(["kept"]);
    },
  );

  it("a derivative's key and hash change while it is pending and not once it is ready", async () => {
    const asset = await plantAsset({ state: "ready" });
    const key = (profile: string) => `ws/${WA}/${asset}/1/${profile}`;
    const [made] = await rows(
      `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state)
       VALUES ($1, $2, 'thumb', $3, 'pending') RETURNING id`,
      [WA, asset, key("thumb")],
    );
    await rows("UPDATE app.media_derivatives SET sha256 = $2 WHERE id = $1", [made?.id, digestOf("derived")]);
    await rows("UPDATE app.media_derivatives SET state = 'ready' WHERE id = $1", [made?.id]);
    for (const set of ["sha256 = $2", "object_key = $2"]) {
      const value = set.startsWith("sha256") ? digestOf("again") : key("other");
      await expect(
        rows(`UPDATE app.media_derivatives SET ${set} WHERE id = $1`, [made?.id, value]),
      ).rejects.toBeDefined();
    }
  });
});

describe("object_key keeps the prefix of its workspace", () => {
  it("is derived by media_register and refused when it names another workspace's prefix", async () => {
    const [made] = await commit(EDITOR, register());
    const id = made?.id as string;
    expect((await assetOf(id))?.object_key).toBe(`ws/${WD}/${id}/1/original`);
    const other = randomUUID();
    await expect(
      rows(
        `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by)
         VALUES ($1, $2, $3, 'foreign.png', 'upload', $4)`,
        [other, WA, `ws/${WB}/${other}/1/original`, U.editor],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("media_register's upload session", () => {
  it("expires 24 hours after registration", async () => {
    const [made] = await commit(EDITOR, register());
    const [session] = await rows(
      "SELECT extract(epoch FROM expires_at - clock_timestamp()) / 3600 AS hours FROM app.media_uploads WHERE media_id = $1",
      [made?.id],
    );
    expect(Number(session?.hours)).toBeGreaterThan(23);
    expect(Number(session?.hours)).toBeLessThanOrEqual(24);
  });
});

// A refusal is 42501 whatever the reason, so a caller learns nothing about another workspace's rows.
interface Definer {
  name: string;
  state?: string;
  session?: true;
  build: (asset: string) => [string, unknown[]];
  valid: TenantCtx;
  alsoRefused: TenantCtx;
}
const DEFINERS: Definer[] = [
  { name: "media_register", build: () => register(), valid: EDITOR, alsoRefused: job([WD]) },
  {
    name: "media_mark_uploaded",
    build: (asset) => markUploaded(WA, asset, digestOf(`caller-${randomUUID()}`)),
    valid: EDITOR,
    alsoRefused: job([WA]),
  },
  {
    name: "media_advance",
    build: (asset) => advance(WA, asset, "pending_upload", "deleted"),
    valid: EDITOR,
    alsoRefused: asUser(U.approver),
  },
  {
    name: "media_derivative_put",
    state: "processing",
    build: (asset) => scalar("media_derivative_put", [WA, asset, "thumb", "pending", null, null, null]),
    valid: job([WA]),
    alsoRefused: ADMIN,
  },
  {
    name: "media_upload_progress",
    session: true,
    build: (asset) => call("media_upload_progress", [WA, asset, [1, 2]]),
    valid: EDITOR,
    alsoRefused: asUser(U.approver),
  },
  {
    name: "media_set_metadata",
    build: (asset) => call("media_set_metadata", [WA, asset, "renamed.png", ["tag"], false]),
    valid: EDITOR,
    alsoRefused: job([WA]),
  },
  {
    name: "media_object_removed",
    state: "deleted",
    build: (asset) => call("media_object_removed", [WA, asset]),
    valid: job([WA]),
    alsoRefused: ADMIN,
  },
  {
    name: "media_gc_candidates",
    build: () => call("media_gc_candidates", [10]),
    valid: job([WA]),
    alsoRefused: ADMIN,
  },
];
const COMMON_REFUSED: [string, TenantCtx][] = [
  ["a Viewer", asUser(U.viewer)],
  ["a service principal", SERVICE],
  ["a portal principal", PORTAL],
  ["a job of another workspace", job([WB])],
  ["an Admin of another workspace", asUser(U.bOwner)],
];

describe("who may run a media definer", () => {
  // The candidate list takes no workspace: any job is a valid caller and sees only its own workspaces' rows.
  const refusedFor = (d: Definer) =>
    COMMON_REFUSED.filter(
      ([who]) => !(d.name === "media_gc_candidates" && who === "a job of another workspace"),
    );
  const cases = DEFINERS.flatMap((d) => [
    ...refusedFor(d).map(([who, ctx]) => ({ d, who, ctx, accepted: false })),
    { d, who: "a member of a kind it does not admit", ctx: d.alsoRefused, accepted: false },
    { d, who: "its valid caller", ctx: d.valid, accepted: true },
  ]);
  it.each(cases)("$d.name as $who", async ({ d, ctx, accepted }) => {
    const asset = await plantAsset({ state: d.state ?? "pending_upload", session: d.session === true });
    const result = await run(ctx, d.build(asset));
    if (accepted) expect(result.error).toBeUndefined();
    else expect(result.error).toMatchObject({ code: "42501" });
  });

  it.each(DEFINERS.filter((d) => !["media_register", "media_gc_candidates"].includes(d.name)))(
    "$name with its valid caller never reaches a row of another workspace and answers it as an unknown id",
    async (d) => {
      const foreign = await plantAsset({ ws: WB, state: d.state ?? "pending_upload" });
      const before = await assetOf(foreign);
      const asForeign = await run(d.valid, d.build(foreign));
      const asUnknown = await run(d.valid, d.build(randomUUID()));
      expect(asForeign.error).toMatchObject({ code: "42501" });
      expect(asUnknown.error).toMatchObject({ code: "42501" });
      expect((asForeign.error as Error).message).toBe((asUnknown.error as Error).message);
      expect(await assetOf(foreign)).toEqual(before);
    },
  );
});

const FACTS = {
  ok: { width: 640, height: 480, duration_ms: 1000, mime: "image/png" },
  text: { width: "abc" },
  overflow: { width: 99_999_999_999 },
  array: [1],
};
describe("media_advance facts", () => {
  const withFacts = (asset: string, from: string, to: string, facts: unknown) =>
    call("media_advance", [WA, asset, from, to, null, JSON.stringify(facts)]);

  it("a job's move applies its facts to the asset", async () => {
    const asset = await plantAsset({ state: "processing" });
    await commit(job([WA]), withFacts(asset, "processing", "ready", FACTS.ok));
    const row = await assetOf(asset);
    expect([row.state, row.width, row.height, row.duration_ms, row.mime]).toEqual([
      "ready",
      640,
      480,
      1000,
      "image/png",
    ]);
  });

  const refused = (name: string, ctx: TenantCtx, from: string, to: string, facts: unknown) => ({
    name,
    ctx,
    from,
    to,
    facts,
  });
  const PROCESSING = ["processing", "ready"] as const;
  it.each([
    refused("a user's move with facts", EDITOR, "ready", "deleted", FACTS.ok),
    refused("a text width", job([WA]), ...PROCESSING, FACTS.text),
    refused("a width that overflows", job([WA]), ...PROCESSING, FACTS.overflow),
    refused("facts that are not an object", job([WA]), ...PROCESSING, FACTS.array),
  ])("$name is refused with 22023 and leaves the row unchanged", async ({ ctx, from, to, facts }) => {
    const asset = await plantAsset({ state: from });
    const before = await assetOf(asset);
    expect((await run(ctx, withFacts(asset, from, to, facts))).error).toMatchObject({ code: "22023" });
    expect(await assetOf(asset)).toEqual(before);
  });
});

const LEGAL: [string, string, TenantCtx][] = [
  ["pending_upload", "deleted", EDITOR],
  ["pending_upload", "deleted", job([WA])],
  // The sweeper frees a stuck asset and its hash.
  ["uploaded", "deleted", job([WA])],
  ["scanning", "deleted", job([WA])],
  ["processing", "deleted", job([WA])],
  ["uploaded", "scanning", job([WA])],
  ["uploaded", "processing", job([WA])],
  ["scanning", "processing", job([WA])],
  ["scanning", "rejected", job([WA])],
  ["processing", "ready", job([WA])],
  ["processing", "rejected", job([WA])],
  ["ready", "deleted", EDITOR],
  ["ready", "deleted", job([WA])],
  ["rejected", "deleted", EDITOR],
  ["rejected", "deleted", job([WA])],
];

interface DerivativeRow {
  name: string;
  asset: string;
  /** A pending derivative of the profile exists already (the move to ready or failed needs one). */
  pending: boolean;
  args: [profile: string, state: string, digest: Buffer | null, size: number | null, error: string | null];
  code?: string;
}
const HASH = digestOf("derivative");
type PutArgs = DerivativeRow["args"];
const row = (name: string, asset: string, pending: boolean, args: PutArgs, code?: string): DerivativeRow =>
  code ? { name, asset, pending, args, code } : { name, asset, pending, args };
const NEW: PutArgs = ["thumb", "pending", null, null, null];
const DERIVATIVE_ROWS: DerivativeRow[] = [
  row("the profile original", "processing", false, ["original", "pending", null, null, null], "22023"),
  row("an asset that is only uploaded", "uploaded", false, NEW, "SH409"),
  row("a deleted asset", "deleted", false, NEW, "SH409"),
  row("a pending derivative of a processing asset", "processing", false, NEW),
  row("a pending derivative of a ready asset", "ready", false, NEW),
  row("ready without a digest", "processing", true, ["thumb", "ready", null, 10, null], "22023"),
  row("ready without a byte size", "processing", true, ["thumb", "ready", HASH, null, null], "22023"),
  row("failed without an error", "processing", true, ["thumb", "failed", null, null, null], "22023"),
  row("ready with its digest and size", "processing", true, ["thumb", "ready", HASH, 10, null]),
  row("failed with its error", "processing", true, ["thumb", "failed", null, null, "transcode failed"]),
];

describe("media_derivative_put rules", () => {
  it.each(DERIVATIVE_ROWS)("$name", async ({ asset, pending, args, code }) => {
    const id = await plantAsset({ state: asset });
    if (pending) {
      await rows(
        `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state)
         VALUES ($1, $2, 'thumb', $3, 'pending')`,
        [WA, id, `ws/${WA}/${id}/1/thumb`],
      );
    }
    const result = await run(job([WA]), scalar("media_derivative_put", [WA, id, ...args]));
    if (code) expect(result.error).toMatchObject({ code });
    else expect(result.error).toBeUndefined();
  });
});

describe("media_upload_progress", () => {
  it.each([
    { name: "an open session of a pending upload stores the parts", state: "pending_upload", session: true },
    {
      name: "a pending upload with no session is refused",
      state: "pending_upload",
      session: false,
      code: "SH409",
    },
    {
      name: "an upload that is no longer pending is refused",
      state: "uploaded",
      session: true,
      code: "SH409",
    },
  ])("$name", async ({ state, session, code }) => {
    const asset = await plantAsset({ state, session });
    const call_ = call("media_upload_progress", [WA, asset, [1, 2, 3]]);
    if (code) return void expect((await run(EDITOR, call_)).error).toMatchObject({ code });
    await commit(EDITOR, call_);
    const stored = await rows("SELECT parts_done FROM app.media_uploads WHERE media_id = $1", [asset]);
    expect(stored[0]?.parts_done).toEqual([1, 2, 3]);
  });
});

describe("a legal state move", () => {
  it.each(LEGAL.map(([from, to, ctx]) => ({ from, to, ctx, who: ctx.principalKind })))(
    "$from to $to by a $who changes the state, stamps deletion and nothing else",
    async ({ from, to, ctx }) => {
      const asset = await plantAsset({ state: from });
      const reason = to === "rejected" ? "scan found a threat" : null;
      await commit(ctx, advance(WA, asset, from, to, reason));
      const row = await assetOf(asset);
      expect([row.state, row.deleted_at !== null, row.reject_reason]).toEqual([to, to === "deleted", reason]);
    },
  );
});

const ILLEGAL: [string, string][] = [
  ["ready", "scanning"],
  ["deleted", "ready"],
  ["uploaded", "ready"],
  ["pending_upload", "processing"],
  ["pending_upload", "uploaded"],
  ["scanning", "uploaded"],
  ["rejected", "ready"],
  ["ready", "processing"],
  ["processing", "scanning"],
  ["deleted", "deleted"],
];

describe("an illegal state move", () => {
  it.each(
    ILLEGAL.flatMap(([from, to]) =>
      [EDITOR, job([WA])].map((ctx) => ({ from, to, ctx, who: ctx.principalKind })),
    ),
  )("$from to $to by a $who is refused and leaves the row unchanged", async ({ from, to, ctx }) => {
    const asset = await plantAsset({ state: from });
    const before = await assetOf(asset);
    expect((await run(ctx, advance(WA, asset, from, to))).error).toMatchObject({ code: "SH409" });
    expect(await assetOf(asset)).toEqual(before);
  });

  it("a from_state that is not the row's state is refused and leaves the row unchanged", async () => {
    const asset = await plantAsset({ state: "ready" });
    const before = await assetOf(asset);
    expect((await run(job([WA]), advance(WA, asset, "processing", "rejected", "late"))).error).toMatchObject({
      code: "SH409",
    });
    expect(await assetOf(asset)).toEqual(before);
  });

  it.each([
    ["uploaded", "scanning"],
    ["uploaded", "processing"],
    ["scanning", "processing"],
    ["scanning", "rejected"],
    ["processing", "ready"],
    ["processing", "rejected"],
    ["uploaded", "deleted"],
    ["scanning", "deleted"],
    ["processing", "deleted"],
  ])("a user Admin cannot reach %s to %s (42501) and the row is unchanged", async (from, to) => {
    const asset = await plantAsset({ state: from });
    const before = await assetOf(asset);
    expect((await run(ADMIN, advance(WA, asset, from, to, "reason"))).error).toMatchObject({ code: "42501" });
    expect(await assetOf(asset)).toEqual(before);
  });
});

describe("a row never points at another workspace's asset", () => {
  const cases: [string, (own: string, foreign: string) => [string, unknown[]], string | undefined][] = [
    [
      "a derivative of another workspace's asset",
      (_own, foreign) => [
        `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state)
         VALUES ('${WA}', '${foreign}', 'thumb', 'ws/${WA}/${foreign}/1/thumb', 'pending')`,
        [],
      ],
      "23503",
    ],
    [
      "an upload of another workspace's asset",
      (_own, foreign) => [
        `INSERT INTO app.media_uploads (workspace_id, media_id, expires_at) VALUES ('${WA}', '${foreign}', now())`,
        [],
      ],
      "23503",
    ],
    [
      "a workspace avatar that is another workspace's asset",
      (_own, foreign) => [`UPDATE app.workspaces SET avatar = '${foreign}' WHERE id = '${WA}'`, []],
      "23503",
    ],
    [
      "a workspace avatar that is its own asset (control)",
      (own) => [`UPDATE app.workspaces SET avatar = '${own}' WHERE id = '${WA}'`, []],
      undefined,
    ],
  ];
  it.each(cases)("%s", async (_name, build, code) => {
    const [own, foreign] = [
      await plantAsset({ state: "ready" }),
      await plantAsset({ ws: WB, state: "ready" }),
    ];
    const [sql, params] = build(own, foreign);
    const outcome = await rows(sql, params).then(
      () => undefined,
      (error: { code?: string }) => error.code,
    );
    expect(outcome).toBe(code);
  });
});

describe("media_gc_candidates (the pending and deleted arms)", () => {
  const candidates = async (ctx: TenantCtx, limit = 500) =>
    (await commit(ctx, call("media_gc_candidates", [limit]))) as {
      workspace_id: string;
      asset_id: string;
      arm: string;
    }[];

  it("returns a pending upload older than 24 hours and a deleted asset 30 days after deletion, as the worker only", async () => {
    const old = await plantAsset({ ageHours: 25 });
    const young = await plantAsset({ ageHours: 23 });
    const gone = await plantAsset({ state: "deleted", deletedDaysAgo: 31 });
    const recent = await plantAsset({ state: "deleted", deletedDaysAgo: 29 });
    const removed = await plantAsset({ state: "deleted", deletedDaysAgo: 31, removed: true });
    const found = await candidates(job([WA]));
    const byId = new Map(found.map((row) => [row.asset_id, row.arm]));
    expect([byId.get(old), byId.get(gone)]).toEqual(["pending_upload", "deleted"]);
    for (const absent of [young, recent, removed]) expect(byId.has(absent)).toBe(false);
  });

  it("is scoped to the workspaces of the job and its limit is 1 to 500", async () => {
    const mine = await plantAsset({ ageHours: 25 });
    const theirs = await plantAsset({ ws: WB, ageHours: 25 });
    const found = await candidates(job([WA]));
    expect(found.every((row) => row.workspace_id === WA)).toBe(true);
    expect(found.map((row) => row.asset_id)).toContain(mine);
    expect(found.map((row) => row.asset_id)).not.toContain(theirs);
    expect(await candidates(job([WA]), 1)).toHaveLength(1);
    for (const bad of [0, -1, 501, null]) {
      const [sql, params] = call("media_gc_candidates", [bad]);
      expect((await run(job([WA]), [sql, params])).error).toMatchObject({ code: "22023" });
    }
  });

  it("media_object_removed stamps a deleted asset, which then leaves the candidates, and refuses a live one", async () => {
    const gone = await plantAsset({ state: "deleted", deletedDaysAgo: 40 });
    await commit(job([WA]), call("media_object_removed", [WA, gone]));
    expect((await assetOf(gone)).object_removed_at).not.toBeNull();
    expect((await candidates(job([WA]))).map((row) => row.asset_id)).not.toContain(gone);
    const live = await plantAsset({ state: "ready" });
    expect((await run(job([WA]), call("media_object_removed", [WA, live]))).error).toMatchObject({
      code: "SH409",
    });
  });
});

const KEY_OF = (id: string) => `ws/${WA}/${id}/1/original`;
async function insertAsset(over: Record<string, unknown>): Promise<string | undefined> {
  const id = randomUUID();
  const values = {
    id,
    workspace_id: WA,
    object_key: KEY_OF(id),
    file_name: "bound.png",
    source: "upload",
    created_by: U.editor,
    state: "pending_upload",
    ...over,
  };
  const columns = Object.keys(values);
  return admin(async (client) =>
    client
      .query(
        `INSERT INTO app.media_assets (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(values),
      )
      .then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
  );
}
const BOUNDS: [string, Record<string, unknown>][] = [
  ["33 tags", { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }],
  ["an empty tag", { tags: [""] }],
  ["a 65-character tag", { tags: ["x".repeat(65)] }],
  ["an empty file name", { file_name: "" }],
  ["a 256-character file name", { file_name: "x".repeat(256) }],
  ["a 201-character reject reason", { reject_reason: "x".repeat(201) }],
  ["a zero byte size", { byte_size: 0 }],
  ["a negative byte size", { byte_size: -1 }],
  ["a zero width", { width: 0 }],
  ["a zero height", { height: 0 }],
  ["a zero duration", { duration_ms: 0 }],
  ["a 31-byte hash", { sha256: digestOf("short").subarray(0, 31) }],
  ["a live state with no hash", { state: "uploaded" }],
  ["an unknown state", { state: "bogus" }],
  ["a source outside the list", { source: "drive" }],
];

describe("the bounds of a media asset", () => {
  it.each(BOUNDS)("refuses %s (23514)", async (_name, over) => {
    expect(await insertAsset(over)).toBe("23514");
  });

  it("accepts the largest valid values (control)", async () => {
    const control = {
      tags: Array.from({ length: 32 }, (_, i) => `t${i}`),
      file_name: "x".repeat(255),
      byte_size: 1,
    };
    expect(await insertAsset(control)).toBeUndefined();
  });

  it("refuses the 101st pending upload of a workspace (53400) and counts only that workspace", async () => {
    await plantPending(WC, 100);
    expect((await run(EDITOR, register(WC))).error).toMatchObject({ code: "53400" });
    expect((await run(EDITOR, register(WD))).error).toBeUndefined();
  });

  // The workspace row is locked before the count, so two callers at 99 cannot both pass the cap.
  it("two callers registering at 99 pending uploads end with 100, one of them refused with 53400", async () => {
    await plantPending(WE, 99);
    const outcomes: Record<number, unknown> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("app"), EDITOR),
      await openTx(db.pool("app"), EDITOR),
      async (client, n) => {
        const [sql, params] = register(WE);
        outcomes[n] = (await client.query(sql, params)).rows[0];
      },
    );
    expect(outcomes[1]).toMatchObject({ id: expect.any(String) });
    expect(result.secondError).toMatchObject({ code: "53400" });
    const [count] = await rows(
      "SELECT count(*)::int AS n FROM app.media_assets WHERE workspace_id = $1 AND state = 'pending_upload'",
      [WE],
    );
    expect(count?.n).toBe(100);
  }, 30_000);
});
