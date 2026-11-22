import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { TenantCtx } from "../../src/context/with-tenant.js";
import {
  cloneTemplate,
  readTestEnv,
  type TestDatabase,
  withAdminClient,
} from "../../src/testing/template.js";
import { asUser, attempt, seedMembers, U, WA, WB } from "../support/members-seed.js";
import { holdThenRace, openTx } from "../support/race.js";

const env = readTestEnv();

// Security floor of migration 0018 (R574, R575): the content tables are written only by the four post definers, a
// caller needs the Editor rank of the workspace (no viewer, approver, service, portal principal, job or foreign
// editor), a stale autosave changes nothing, an old version is never edited, and every row stays in its own
// workspace. The snapshot carries the draft the definers rebuild the variants and media from. Rows that must be seen
// are planted as the superuser; nothing sleeps. The argument lists and outcome names are the contract of the migration.
let db: TestDatabase;
const admin = <T>(run: (client: Client) => Promise<T>) => withAdminClient(env, db.name, run);
const rows = (sql: string, params: unknown[] = []) =>
  admin(async (client) => (await client.query(sql, params)).rows);

// Two channels and two assets of workspace A, and one of each in workspace B.
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

// The draft shape the write definers rebuild variants and media from, inside the snapshot under the key `draft`.
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

// A post and its variant planted directly as the superuser, for the rows that need a post without a definer call.
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
    "an UPDATE or DELETE of a version is refused for %s",
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
          await expect(client.query(statement, [post])).rejects.toMatchObject({ code: "42501" });
          await client.query("ROLLBACK");
        }
      });
      expect((await versionsOf(post)).length).toBe(1);
    },
  );
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

  it.each([
    [
      "26 parts",
      [variant(CH1, { parts: Array.from({ length: 26 }, () => ({ kind: "thread_reply", text: "x" })) })],
    ],
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
