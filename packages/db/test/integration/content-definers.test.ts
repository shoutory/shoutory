import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import { migrationsDir } from "../../src/migrate/runner.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Rows that must be seen are planted as the superuser; nothing sleeps.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

const CH1 = randomUUID();
const CH2 = randomUUID();
const CHB = randomUUID();
const MED1 = randomUUID();
const MED2 = randomUUID();
const MEDB = randomUUID();

beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
  await admin(async (client) => {
    await seedMembers(client);
    for (const [id, ws, account] of [
      [CH1, WA, "content-ch1"],
      [CH2, WA, "content-ch2"],
      [CHB, WB, "content-chb"],
    ]) {
      await client.query(
        `INSERT INTO app.channels (id, workspace_id, provider_id, account_kind, provider_account_id, display_name)
         VALUES ($1, $2, 'fixture-oauth', 'profile', $3, $3)`,
        [id, ws, account],
      );
    }
    for (const [id, ws] of [
      [MED1, WA],
      [MED2, WA],
      [MEDB, WB],
    ]) {
      await client.query(
        `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, source, created_by, state, sha256)
         VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'content.png', 'upload',
           $3::uuid, 'ready', sha256(convert_to($1::text, 'UTF8')))`,
        [id, ws, U.editor],
      );
    }
  });
});
afterAll(() => db.drop());

const EDITOR = asUser(U.editor);
const job = (): TenantCtx => ({ principalKind: "job", principalId: randomUUID(), workspaceIds: [WA] });
const SERVICE: TenantCtx = {
  principalKind: "service",
  serviceKind: "api_key",
  principalId: randomUUID(),
  workspaceIds: [WA],
  writeWorkspaceId: WA,
};
const PORTAL: TenantCtx = { principalKind: "portal", portalGrantId: randomUUID(), workspaceIds: [WA] };
const reader = (user: string, workspace: string): TenantCtx => ({
  principalKind: "user",
  principalId: user,
  workspaceIds: [workspace],
});
const poolOf = (ctx: TenantCtx) => db.pool(ctx.principalKind === "job" ? "worker" : "app");

type Row = Record<string, unknown>;
const variant = (channel: string, change: Row = {}) => ({
  channel_id: channel,
  locale: null,
  post_type: "text",
  text: "hello",
  parts: [] as unknown[],
  settings: {},
  media: [] as Row[],
  ...change,
});
const medium = (id: string, alt: string | null = null) => ({ media_id: id, alt_text: alt, crop: null });
const digest = (label: string) => createHash("sha256").update(label).digest();
const snapshot = (variants: Row[], label: string) => JSON.stringify({ draft: { variants }, label });

type Call = [string, unknown[]];
const create = (variants: Row[], label = "v1", ws = WA): Call => [
  "SELECT * FROM app.post_create($1, $2::jsonb, $3)",
  [ws, snapshot(variants, label), digest(label)],
];
const write = (
  name: "post_autosave" | "post_save",
  post: string,
  expected: string,
  variants: Row[],
  label: string,
): Call => [
  `SELECT * FROM app.${name}($1, $2, $3, $4::jsonb, $5)`,
  [WA, post, expected, snapshot(variants, label), digest(label)],
];
const restore = (post: string, expected: string, source: string): Call => [
  "SELECT * FROM app.post_restore($1, $2, $3, $4)",
  [WA, post, expected, source],
];
const commit = async (ctx: TenantCtx, [sql, params]: Call): Promise<Row[]> => {
  const client = await openTx(poolOf(ctx), ctx);
  try {
    const result = (await client.query(sql, params)).rows;
    await client.query("COMMIT");
    return result;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
};
const run = (ctx: TenantCtx, [sql, params]: Call) => attempt(poolOf(ctx), ctx, sql, params);

interface Made {
  post: string;
  version: string;
}
async function createPost(variants: Row[] = [variant(CH1)], label = "v1"): Promise<Made> {
  const [made] = await commit(EDITOR, create(variants, label));
  return { post: made?.post_id as string, version: made?.version_id as string };
}
const postOf = async (id: string) => (await rows("SELECT * FROM app.posts WHERE id = $1", [id]))[0];
const versionsOf = (post: string) =>
  rows(
    "SELECT id, version_no, kind, snapshot, snapshot_hash FROM app.post_versions WHERE post_id = $1 ORDER BY version_no",
    [post],
  );
const variantsOf = (post: string) =>
  rows(
    "SELECT id, channel_id, locale, text FROM app.post_variants WHERE post_id = $1 ORDER BY channel_id, locale",
    [post],
  );
const mediaOf = (variant_id: string) =>
  rows("SELECT media_id, position FROM app.post_media WHERE variant_id = $1 ORDER BY position", [variant_id]);

async function plantPost(ws = WA, channel = CH1): Promise<{ post: string; variant: string }> {
  const [post] = await rows(
    "INSERT INTO app.posts (workspace_id, author_kind, author_id) VALUES ($1, 'user', $2) RETURNING id",
    [ws, U.editor],
  );
  const [made] = await rows(
    "INSERT INTO app.post_variants (workspace_id, post_id, channel_id) VALUES ($1, $2, $3) RETURNING id",
    [ws, post?.id, channel],
  );
  return { post: post?.id as string, variant: made?.id as string };
}

describe("who may call a post definer", () => {
  const CALLERS: [string, () => TenantCtx][] = [
    ["an approver", () => asUser(U.approver)],
    ["a viewer", () => asUser(U.viewer)],
    ["a service principal", () => SERVICE],
    ["a portal principal", () => PORTAL],
    ["a job", job],
    ["an editor of another workspace", () => asUser(U.bOwner)],
  ];
  const ANY = randomUUID();
  const DEFINERS: [string, Call][] = [
    ["post_create", create([variant(CH1)])],
    ["post_autosave", write("post_autosave", ANY, ANY, [variant(CH1)], "x")],
    ["post_save", write("post_save", ANY, ANY, [variant(CH1)], "x")],
    ["post_restore", restore(ANY, ANY, ANY)],
  ];
  it.each(CALLERS.flatMap(([who, ctx]) => DEFINERS.map(([name, call]) => [who, name, ctx, call] as const)))(
    "refuses %s calling %s",
    async (_who, _name, ctx, call) => {
      expect((await run(ctx(), call)).error).toMatchObject({ code: "42501" });
    },
  );

  it("a viewer reads a post of the workspace, and a member of another workspace reads none of it", async () => {
    const { post } = await plantPost();
    const count = (ctx: TenantCtx) =>
      attempt(db.pool("app"), ctx, "SELECT count(*)::int AS n FROM app.posts WHERE id = $1", [post]);
    expect((await count(reader(U.viewer, WA))).rows).toEqual([{ n: 1 }]);
    expect((await count(reader(U.bOwner, WB))).rows).toEqual([{ n: 0 }]);
  });
});

describe("post_create", () => {
  it("stores the post, its first version, the variants and their media, and points the post at the version", async () => {
    const { post, version } = await createPost(
      [variant(CH1, { text: "first", media: [medium(MED1, "alt one")] })],
      "created",
    );
    expect(await postOf(post)).toMatchObject({
      workspace_id: WA,
      author_kind: "user",
      author_id: U.editor,
      origin: "ui",
      status: "draft",
      current_version_id: version,
    });
    const [only] = await versionsOf(post);
    expect(only).toMatchObject({
      id: version,
      version_no: 1,
      kind: "save",
      snapshot_hash: digest("created"),
    });
    expect(only?.snapshot).toMatchObject({ label: "created" });
    const [made] = await variantsOf(post);
    expect(made).toMatchObject({ channel_id: CH1, locale: null, text: "first" });
    expect(await mediaOf(made?.id as string)).toEqual([{ media_id: MED1, position: 0 }]);
  });

  it("refuses a snapshot with no draft object", async () => {
    const result = await run(EDITOR, [
      "SELECT * FROM app.post_create($1, $2::jsonb, $3)",
      [WA, '{"label":"x"}', digest("x")],
    ]);
    expect(result.error).toMatchObject({ code: "22023" });
  });
});

describe("autosave and save", () => {
  it("with a stale expected version changes nothing and reports stale with the current version", async () => {
    const { post, version } = await createPost([variant(CH1, { text: "kept", media: [medium(MED1)] })]);
    const before = await variantsOf(post);
    const [answer] = await commit(
      EDITOR,
      write(
        "post_autosave",
        post,
        randomUUID(),
        [variant(CH1, { text: "lost", media: [medium(MED2)] }), variant(CH2)],
        "late",
      ),
    );
    expect(answer).toMatchObject({ outcome: "stale", version_id: version });
    expect((await versionsOf(post)).length).toBe(1);
    expect(await variantsOf(post)).toEqual(before);
    expect(await mediaOf(before[0]?.id as string)).toEqual([{ media_id: MED1, position: 0 }]);
    expect((await postOf(post))?.current_version_id).toBe(version);
  });

  it("with the current version writes an autosave version, moves the current version and numbers them without a gap", async () => {
    const { post, version } = await createPost();
    const [second] = await commit(
      EDITOR,
      write("post_autosave", post, version, [variant(CH1, { text: "two" })], "v2"),
    );
    expect(second).toMatchObject({ outcome: "ok" });
    const [third] = await commit(
      EDITOR,
      write("post_autosave", post, second?.version_id as string, [variant(CH1, { text: "three" })], "v3"),
    );
    expect(third).toMatchObject({ outcome: "ok" });
    expect((await versionsOf(post)).map((v) => [v.version_no, v.kind])).toEqual([
      [1, "save"],
      [2, "autosave"],
      [3, "autosave"],
    ]);
    expect((await postOf(post))?.current_version_id).toBe(third?.version_id);
    expect((await variantsOf(post))[0]?.text).toBe("three");
  });
});

describe("autosave races", () => {
  it("two autosaves on one expected version end with one ok and one stale, never two versions from the same base", async () => {
    const { post, version } = await createPost();
    const answers: Record<number, Row | undefined> = {};
    const result = await holdThenRace(
      rows,
      await openTx(db.pool("app"), EDITOR),
      await openTx(db.pool("app"), EDITOR),
      async (client, n) => {
        const [sql, params] = write(
          "post_autosave",
          post,
          version,
          [variant(CH1, { text: `racer ${n}` })],
          `race ${n}`,
        );
        answers[n] = (await client.query(sql, params)).rows[0];
      },
    );
    expect(result.secondError).toBeUndefined();
    expect(answers[1]).toMatchObject({ outcome: "ok" });
    expect(answers[2]).toMatchObject({ outcome: "stale", version_id: answers[1]?.version_id });
    expect((await versionsOf(post)).length).toBe(2);
    expect((await variantsOf(post))[0]?.text).toBe("racer 1");
  });
});

describe("save", () => {
  it("replaces the variant set: a kept variant keeps its id, a new one is added, an absent one goes, media are replaced", async () => {
    const { post, version } = await createPost(
      [variant(CH1, { media: [medium(MED1)] }), variant(CH2)],
      "base",
    );
    const [kept, dropped] = await variantsOf(post);
    const first = [kept, dropped].find((v) => v?.channel_id === CH1);
    const [saved] = await commit(
      EDITOR,
      write(
        "post_save",
        post,
        version,
        [
          variant(CH1, { text: "edited", media: [medium(MED2, "new alt")] }),
          variant(CH1, { locale: "ar", text: "arabic" }),
        ],
        "saved",
      ),
    );
    expect(saved).toMatchObject({ outcome: "ok" });
    const after = await variantsOf(post);
    // Ordered by locale, a NULL locale last.
    expect(after.map((v) => [v.channel_id, v.locale, v.text])).toEqual([
      [CH1, "ar", "arabic"],
      [CH1, null, "edited"],
    ]);
    const same = after.find((v) => v.locale === null);
    expect(same?.id).toBe(first?.id);
    expect(await mediaOf(same?.id as string)).toEqual([{ media_id: MED2, position: 0 }]);
    expect(
      await rows("SELECT 1 FROM app.post_variants WHERE id = $1", [
        dropped?.id === first?.id ? kept?.id : dropped?.id,
      ]),
    ).toEqual([]);
    expect((await versionsOf(post)).at(-1)).toMatchObject({ kind: "save", version_no: 2 });
  });
});

describe("restore", () => {
  it("creates a new version with the old snapshot and hash, rebuilds the live content from it and leaves every old version as it was", async () => {
    const { post, version } = await createPost(
      [variant(CH1, { text: "one", media: [medium(MED1)] })],
      "first",
    );
    const [auto] = await commit(
      EDITOR,
      write("post_autosave", post, version, [variant(CH1, { text: "two" })], "second"),
    );
    const before = await versionsOf(post);
    const [restored] = await commit(EDITOR, restore(post, auto?.version_id as string, version));
    expect(restored).toMatchObject({ outcome: "ok" });
    const after = await versionsOf(post);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toMatchObject({ version_no: 3, kind: "save", snapshot_hash: before[0]?.snapshot_hash });
    expect(after[2]?.snapshot).toEqual(before[0]?.snapshot);
    expect((await postOf(post))?.current_version_id).toBe(restored?.version_id);
    const [live] = await variantsOf(post);
    expect(live?.text).toBe("one");
    expect(await mediaOf(live?.id as string)).toEqual([{ media_id: MED1, position: 0 }]);
  });
});

describe("restore refusals", () => {
  it("with a stale expected version changes nothing, and refuses a version of another post", async () => {
    const one = await createPost([variant(CH1, { media: [medium(MED1)] })]);
    const other = await createPost([variant(CH2)], "other");
    const [auto] = await commit(
      EDITOR,
      write("post_autosave", one.post, one.version, [variant(CH1, { text: "newer" })], "newer"),
    );
    const before = await variantsOf(one.post);
    const stale = await commit(EDITOR, restore(one.post, one.version, one.version));
    expect(stale[0]).toMatchObject({ outcome: "stale", version_id: auto?.version_id });
    expect((await versionsOf(one.post)).length).toBe(2);
    expect(await variantsOf(one.post)).toEqual(before);
    expect(await mediaOf(before[0]?.id as string)).toEqual([]);
    expect((await postOf(one.post))?.current_version_id).toBe(auto?.version_id);
    expect(
      (await run(EDITOR, restore(one.post, auto?.version_id as string, other.version))).error,
    ).toMatchObject({
      code: "42501",
    });
  });

  it.each(["shoutory_definer", "shoutory_app", "shoutory_worker"])(
    "an UPDATE or DELETE of a version changes nothing for %s outside the purge",
    async (role) => {
      const { post } = await createPost();
      await admin(async (client) => {
        for (const statement of [
          "UPDATE app.post_versions SET kind = 'published' WHERE post_id = $1",
          "DELETE FROM app.post_versions WHERE post_id = $1",
        ]) {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          await client.query("SELECT set_config('app.job_purpose', 'post_restore', true)");
          // The purge needs DELETE on the table, so for it the row policy is what keeps every other purpose out.
          if (role === "shoutory_definer" && statement.startsWith("DELETE")) {
            expect((await client.query(statement, [post])).rowCount).toBe(0);
          } else {
            await expect(client.query(statement, [post])).rejects.toMatchObject({ code: "42501" });
          }
          await client.query("ROLLBACK");
        }
      });
      expect((await versionsOf(post)).length).toBe(1);
    },
  );
});

const DUE = new Date("2030-01-02T03:04:05Z");

async function plantOperation(
  ws: string,
  variantId: string,
  channel: string,
  state: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const given: Record<string, unknown> = {
    workspace_id: ws,
    variant_id: variantId,
    channel_id: channel,
    provider_id: "fixture-oauth",
    queue: "publish.fixture-oauth",
    kind: "publish",
    state,
    last_actor: "S",
    due_at: DUE,
    lateness_deadline: new Date(DUE.getTime() + 7_200_000),
    idempotency_marker: `guard-${randomUUID()}`,
    requested_by: U.editor,
    ...(state === "published" ? { effect: "confirmed", settled_at: DUE } : {}),
    ...extra,
  };
  const names = Object.keys(given);
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO app.operations (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(given),
    );
    await client.query("COMMIT");
  });
}

interface Stage {
  state: string;
  op?: string;
  published?: boolean;
  postStatus?: string;
}
interface TwoVersions extends Made {
  first: string;
}
// Two versions, "one" then "two"; a frozen variant is frozen on the current one, so every call below changes it.
async function twoVersions(): Promise<TwoVersions> {
  const one = await createPost([variant(CH1, { text: "one" })], "one");
  const [two] = await commit(
    EDITOR,
    write("post_autosave", one.post, one.version, [variant(CH1, { text: "two" })], "two"),
  );
  return { post: one.post, version: two?.version_id as string, first: one.version };
}
async function stage(made: Made, s: Stage): Promise<string> {
  const id = (await variantsOf(made.post))[0]?.id as string;
  await rows(
    `UPDATE app.post_variants SET schedule_state = $2, due_at = $3, frozen_version_id = $4, published_at = $5
     WHERE id = $1`,
    [id, s.state, DUE, s.state === "draft" ? null : made.version, s.published ? DUE : null],
  );
  if (s.postStatus) await rows("UPDATE app.posts SET status = $2 WHERE id = $1", [made.post, s.postStatus]);
  if (s.op) await plantOperation(WA, id, CH1, s.op);
  return id;
}
const variantState = async (id: string) =>
  (
    await rows("SELECT schedule_state, due_at, frozen_version_id FROM app.post_variants WHERE id = $1", [id])
  )[0];

const CALLS: [string, (m: TwoVersions) => Call][] = [
  ["autosave", (m) => write("post_autosave", m.post, m.version, [variant(CH1, { text: "three" })], "three")],
  ["save", (m) => write("post_save", m.post, m.version, [variant(CH1, { text: "three" })], "three")],
  ["restore", (m) => restore(m.post, m.version, m.first)],
];
const WRITTEN: [string, Stage, string, boolean][] = [
  ["draft", { state: "draft" }, "draft", false],
  ["needs_approval", { state: "needs_approval" }, "needs_approval", true],
  ["approved", { state: "approved" }, "approved", true],
  ["scheduled", { state: "scheduled" }, "scheduled", true],
  ["failed", { state: "settled", op: "failed", postStatus: "failed" }, "draft", false],
];
const REFUSED: [string, Stage, string][] = [
  ["held", { state: "held", op: "needs_human", postStatus: "needs_attention" }, "post_in_flight"],
  ["in_progress", { state: "in_progress", op: "pending", postStatus: "scheduled" }, "post_in_flight"],
  ["published", { state: "settled", op: "published", published: true, postStatus: "published" }, "use_edit"],
  ["archived", { state: "draft", postStatus: "archived" }, "post_archived"],
];
const refusal = (reason: string) => ({ code: "SH409", message: `post: ${reason}` });

describe("the state guard on a changed variant", () => {
  it.each(
    CALLS.flatMap(([how, call]) =>
      WRITTEN.map(([what, s, after, pending]) => [what, how, s, after, pending, call] as const),
    ),
  )(
    "%s: a variant changed by %s is written; a frozen one keeps its state, time and frozen version",
    async (_what, _how, s, after, pending, call) => {
      const made = await twoVersions();
      const id = await stage(made, s);
      const [answer] = await commit(EDITOR, call(made));
      expect(answer).toMatchObject({ outcome: "ok", pending_changes: pending ? [id] : [] });
      expect(await variantState(id)).toEqual({
        schedule_state: after,
        due_at: DUE,
        frozen_version_id: after === "draft" ? null : made.version,
      });
      expect((await postOf(made.post))?.status).toBe("draft");
    },
  );

  it.each(
    CALLS.flatMap(([how, call]) => REFUSED.map(([what, s, reason]) => [what, how, s, reason, call] as const)),
  )(
    "%s: a variant changed by %s is refused with its reason and nothing is written",
    async (_what, _how, s, reason, call) => {
      const made = await twoVersions();
      const id = await stage(made, s);
      const before = [await versionsOf(made.post), await variantState(id), await postOf(made.post)];
      expect((await run(EDITOR, call(made))).error).toMatchObject(refusal(reason));
      expect([await versionsOf(made.post), await variantState(id), await postOf(made.post)]).toEqual(before);
    },
  );
});

describe("the state guard is per variant", () => {
  it("an unchanged variant passes while a changed sibling is refused, and only frozen variants are listed", async () => {
    const one = await createPost([variant(CH1, { text: "a" }), variant(CH2, { text: "b" })], "pair");
    const ids = Object.fromEntries((await variantsOf(one.post)).map((v) => [v.channel_id, v.id as string]));
    const [busy, frozen] = [ids[CH1] as string, ids[CH2] as string];
    await rows("UPDATE app.post_variants SET schedule_state = 'in_progress' WHERE id = $1", [busy]);
    await plantOperation(WA, busy, CH1, "pending");
    await rows(
      "UPDATE app.post_variants SET schedule_state = 'scheduled', due_at = $2, frozen_version_id = $3 WHERE id = $1",
      [frozen, DUE, one.version],
    );
    const pair = (a: string, b: string) => [variant(CH1, { text: a }), variant(CH2, { text: b })];
    const [ok] = await commit(EDITOR, write("post_save", one.post, one.version, pair("a", "b2"), "sibling"));
    expect(ok).toMatchObject({ outcome: "ok", pending_changes: [frozen] });
    const late = write("post_save", one.post, ok?.version_id as string, pair("a2", "b2"), "busy");
    expect((await run(EDITOR, late)).error).toMatchObject(refusal("post_in_flight"));
  });

  it.each(["failed", "published"])(
    "dropping a variant with a %s operation answers variant_has_history, and one without is dropped",
    async (op) => {
      const one = await createPost([variant(CH1), variant(CH2)], "drop");
      const ids = Object.fromEntries((await variantsOf(one.post)).map((v) => [v.channel_id, v.id as string]));
      await rows("UPDATE app.post_variants SET schedule_state = 'settled', published_at = $2 WHERE id = $1", [
        ids[CH1],
        op === "published" ? DUE : null,
      ]);
      await plantOperation(WA, ids[CH1] as string, CH1, op);
      const history = write("post_save", one.post, one.version, [variant(CH2)], "drop history");
      expect((await run(EDITOR, history)).error).toMatchObject(refusal("variant_has_history"));
      const [ok] = await commit(
        EDITOR,
        write("post_save", one.post, one.version, [variant(CH1)], "drop clean"),
      );
      expect(ok).toMatchObject({ outcome: "ok" });
      expect((await variantsOf(one.post)).map((v) => v.id)).toEqual([ids[CH1]]);
    },
  );
});

describe("the state guard sees every bound field", () => {
  const BASE = variant(CH1, {
    text: "one",
    parts: [{ text: "part" }],
    settings: { mode: "a" },
    media: [medium(MED1, "alt"), medium(MED2)],
  });
  const reordered = Object.fromEntries(
    Object.entries({
      ...BASE,
      media: [{ crop: null, alt_text: "alt", media_id: MED1.toUpperCase() }, medium(MED2)],
    }).reverse(),
  );
  const EDITS: [string, Row, boolean][] = [
    ["nothing (keys reordered, a media id in upper case)", reordered, false],
    ["the text", { ...BASE, text: "two" }, true],
    ["the parts", { ...BASE, parts: [{ text: "other" }] }, true],
    ["the settings", { ...BASE, settings: { mode: "b" } }, true],
    ["the post type", { ...BASE, post_type: "image" }, true],
    ["the media order", { ...BASE, media: [medium(MED2), medium(MED1, "alt")] }, true],
    ["a medium removed", { ...BASE, media: [medium(MED1, "alt")] }, true],
    ["an alt text", { ...BASE, media: [medium(MED1, "other"), medium(MED2)] }, true],
    ["a crop", { ...BASE, media: [{ ...medium(MED1, "alt"), crop: { x: 1 } }, medium(MED2)] }, true],
  ];
  it.each(EDITS)(
    "a save changing %s on a running variant is refused only when changed",
    async (_what, edit, changed) => {
      const made = await createPost([BASE], "fields");
      await stage(made, { state: "in_progress", op: "pending" });
      const { error } = await run(EDITOR, write("post_save", made.post, made.version, [edit], "edited"));
      expect(error ?? null).toEqual(changed ? expect.objectContaining(refusal("post_in_flight")) : null);
    },
  );
});

describe("the state guard leaves the record and other workspaces alone", () => {
  it("a write to a frozen variant changes no version row and no frozen hash", async () => {
    const made = await twoVersions();
    await stage(made, { state: "scheduled" });
    const before = await versionsOf(made.post);
    await commit(
      EDITOR,
      write("post_save", made.post, made.version, [variant(CH1, { text: "three" })], "three"),
    );
    const after = await versionsOf(made.post);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });

  it.each(REFUSED)(
    "%s: a stale expected version answers stale before any refusal and writes nothing",
    async (_what, s) => {
      const made = await twoVersions();
      const id = await stage(made, s);
      const before = [await versionsOf(made.post), await variantState(id)];
      const late = write("post_save", made.post, made.first, [variant(CH1, { text: "late" })], "late");
      expect((await commit(EDITOR, late))[0]).toMatchObject({ outcome: "stale", version_id: made.version });
      expect([await versionsOf(made.post), await variantState(id)]).toEqual(before);
    },
  );

  it("a post of another workspace is refused as unknown, whatever its variant's state", async () => {
    const { post, variant: theirs } = await plantPost(WB, CHB);
    await rows("UPDATE app.post_variants SET schedule_state = 'in_progress' WHERE id = $1", [theirs]);
    await plantOperation(WB, theirs, CHB, "pending");
    for (const ws of [WA, WB]) {
      const call: Call = [
        "SELECT * FROM app.post_save($1, $2, $3, $4::jsonb, $5)",
        [ws, post, randomUUID(), snapshot([variant(CH1)], "foreign"), digest("foreign")],
      ];
      expect((await run(EDITOR, call)).error).toMatchObject({ code: "42501" });
    }
  });
});

describe("the purpose setting", () => {
  const CASES: [string, (made: Made) => Call, boolean][] = [
    ["an ok write", (m) => write("post_autosave", m.post, m.version, [variant(CH1)], "purpose ok"), false],
    [
      "a stale write",
      (m) => write("post_save", m.post, randomUUID(), [variant(CH1)], "purpose stale"),
      false,
    ],
    ["a refused call caught under a savepoint", (m) => restore(m.post, m.version, randomUUID()), true],
  ];
  it.each(CASES)("is back to its prior value after %s", async (_what, build, refused) => {
    const client = await openTx(db.pool("app"), EDITOR);
    try {
      await client.query("SELECT set_config('app.job_purpose', 'prior-purpose', true)");
      const [sql, params] = build(await createPost());
      if (refused) {
        await client.query("SAVEPOINT refused");
        await expect(client.query(sql, params)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT refused");
      } else {
        await client.query(sql, params);
      }
      const after = await client.query("SELECT current_setting('app.job_purpose', true) AS purpose");
      expect(after.rows).toEqual([{ purpose: "prior-purpose" }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("keys and bounds", () => {
  it("a variant is unique per post, channel and locale, and a NULL locale counts as one value", async () => {
    const { post } = await plantPost();
    const insert = (locale: string | null) =>
      rows(
        "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, locale) VALUES ($1, $2, $3, $4)",
        [WA, post, CH2, locale],
      );
    await insert(null);
    await expect(insert(null)).rejects.toMatchObject({ code: "23505" });
    await insert("ar");
    await expect(insert("ar")).rejects.toMatchObject({ code: "23505" });
  });

  it("post_media refuses another workspace's media, and a draft refuses another workspace's channel", async () => {
    const media = await run(EDITOR, create([variant(CH1, { media: [medium(MEDB)] })]));
    expect(media.error).toMatchObject({ code: "23503" });
    const channel = await run(EDITOR, create([variant(CHB)]));
    expect(channel.error).toMatchObject({ code: "23503" });
  });

  it("a draft of 61 parts is stored: the parts are bounded by their bytes alone", async () => {
    const parts = Array.from({ length: 61 }, () => ({ kind: "thread_reply", text: "x" }));
    expect((await run(EDITOR, create([variant(CH1, { parts })]))).error).toBeUndefined();
  });

  it.each([
    ["an unknown post type", [variant(CH1, { post_type: "bogus" })]],
    ["a 36 character locale", [variant(CH1, { locale: "x".repeat(36) })]],
    ["33 media in one variant", [variant(CH1, { media: Array.from({ length: 33 }, () => medium(MED1)) })]],
    ["101 variants", Array.from({ length: 101 }, (_, n) => variant(CH1, { locale: `l${n}` }))],
  ])("a draft with %s is refused by a check", async (_what, bad) => {
    expect((await run(EDITOR, create(bad))).error).toMatchObject({ code: "23514" });
  });
});

describe("the idempotency key table", () => {
  it("purge_expired deletes a key one hour past its expiry and keeps a younger or a live one", async () => {
    const plant = (id: string, interval: string) =>
      rows(
        `INSERT INTO app.idempotency_keys (workspace_id, principal_kind, principal_id, key, request_hash, expires_at)
         VALUES ($1, 'user', $2, $3, sha256(convert_to($3, 'UTF8')), now() + $4::interval)`,
        [WA, U.editor, id, interval],
      );
    await plant("old", "-2 hours");
    await plant("recent", "-30 minutes");
    await plant("live", "1 hour");
    const [purged] = (
      await db.pool("worker").query("SELECT removed FROM app.purge_expired('app.idempotency_keys')")
    ).rows;
    expect(Number(purged?.removed)).toBe(1);
    expect((await rows("SELECT key FROM app.idempotency_keys ORDER BY key")).map((r) => r.key)).toEqual([
      "live",
      "recent",
    ]);
  });
});

describe("autosave retention", () => {
  const purge = async () =>
    Number(
      (await db.pool("worker").query("SELECT removed FROM app.purge_expired('app.post_versions_autosave')"))
        .rows[0]?.removed,
    );

  // Versions 2-56 are autosaves and 57 is a save; 2, 10 and 57 are 40 days old. The newest 50 autosaves are 7-56.
  it("removes autosaves older than 30 days or beyond the newest 50, never a named version or another kind", async () => {
    const made = await createPost([variant(CH1)], "retained");
    const planted = await rows(
      `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by,
         created_at)
       SELECT $1, $2::uuid, n, CASE WHEN n = 57 THEN 'save' ELSE 'autosave' END, '{}'::jsonb,
         sha256(convert_to($2::text || n, 'UTF8')), $3,
         CASE WHEN n IN (2, 10, 57) THEN now() - interval '40 days' ELSE now() END
       FROM generate_series(2, 57) AS n RETURNING id, version_no`,
      [WA, made.post, U.editor],
    );
    const id = (n: number) => planted.find((row) => row.version_no === n)?.id as string;
    const target = (await variantsOf(made.post))[0]?.id as string;
    await rows(
      "UPDATE app.post_variants SET schedule_state = 'scheduled', due_at = $2, frozen_version_id = $3 WHERE id = $1",
      [target, DUE, id(3)],
    );
    await plantOperation(WA, target, CH1, "pending", {
      frozen_version_id: id(4),
      frozen_snapshot_hash: digest("frozen"),
    });
    await rows("UPDATE app.posts SET current_version_id = $2 WHERE id = $1", [made.post, id(5)]);
    expect(await purge()).toBe(3);
    expect(await purge()).toBe(0);
    const kept = Array.from({ length: 57 }, (_, i) => i + 1).filter((n) => ![2, 6, 10].includes(n));
    expect((await versionsOf(made.post)).map((row) => row.version_no)).toEqual(kept);
  });
});

describe("the language tag migration", () => {
  const MIGRATION = join(migrationsDir, "0033_variant_locale_case.sql");
  const apply = async () => {
    const sql = await readFile(MIGRATION, "utf8");
    await admin((client) => client.query(sql));
  };
  const plantLocales = async (locales: string[]) => {
    const { post } = await plantPost();
    for (const locale of locales) {
      await rows(
        "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, locale) VALUES ($1, $2, $3, $4)",
        [WA, post, CH2, locale],
      );
    }
    return post;
  };

  it("rewrites every stored tag to the case Intl.getCanonicalLocales gives", async () => {
    const given = ["en-us", "zh-hant-tw", "AR", "en-x-PRIV", "sr-latn-rs-u-CA-gregory"];
    const post = await plantLocales(given);
    await apply();
    const stored = await rows("SELECT locale FROM app.post_variants WHERE post_id = $1 AND channel_id = $2", [
      post,
      CH2,
    ]);
    expect(stored.map((row) => row.locale).sort()).toEqual(Intl.getCanonicalLocales(given).sort());
  });

  it("fails loudly when two tags of one channel differ only in case", async () => {
    await plantLocales(["en-us", "en-US"]);
    await expect(apply()).rejects.toMatchObject({ code: "23505" });
  });

  it("fails loudly on a stored tag that is not well formed and rewrites nothing", async () => {
    const post = await plantLocales(["fr-ca", "fr_CA!"]);
    await expect(apply()).rejects.toMatchObject({ code: "23514" });
    const stored = await rows("SELECT locale FROM app.post_variants WHERE post_id = $1 AND channel_id = $2", [
      post,
      CH2,
    ]);
    expect(stored.map((row) => row.locale).sort()).toEqual(["fr-ca", "fr_CA!"]);
  });
});
