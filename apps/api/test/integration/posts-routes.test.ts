import { randomUUID } from "node:crypto";
import { jsonbBytes } from "@shoutory/core/content";
import { snapshotHash } from "@shoutory/core/content/snapshot";
import { SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { snapshotOf } from "@shoutory/provider-sdk/snapshot";
import { fixtureOAuthManifest } from "@shoutory/testkit/fixture-oauth/manifest";
import { createFixtureAdapter } from "@shoutory/testkit/fixture-provider/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leaks } from "../support/canary.js";
import {
  addWorkspaceMember,
  seedChannel,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, PEPPER, startFixture } from "./auth/harness.js";

// Security floor of the posts routes: who may read and who may change a post, the one 404 for what the caller may not
// see (another workspace, a deleted post), the ETag and If-Match rules of autosave, save and restore, a double submit,
// no post text in any log line, the refusals of a draft the database could not store, and the exact byte limits as
// PostgreSQL measures them. The routes read the draft through core and write through the four post definers.

type User = { id: string; cookie: string };
const DEFAULTS = { max_length: 280, sensitive: false, tag: "x" };
const manifest = manifestSchema.parse({ ...fixtureOAuthManifest, providerDefault: DEFAULTS });
const DIGEST = snapshotOf(manifest, new Date(0)).manifestDigest;
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
let fx: Fixture;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};
let c1: string;
let cOther: string;
const media = { ready: "", pending: "", foreign: "" };

interface Facts {
  /** The size of the `stripped` derivative, the one a provider receives. */
  bytes?: number;
  width?: number;
  height?: number;
  /** `false` plants a ready asset whose `stripped` derivative is missing. */
  stripped?: boolean;
}
// An asset as the pipeline leaves it: a ready one has its sniffed type, its size in pixels and a ready `stripped` derivative.
async function plantMedia(workspace: string, state: string, facts: Facts = {}): Promise<string> {
  const id = randomUUID();
  const ready = state === "ready";
  await fx.admin(async (client) => {
    await client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, width, height, source, created_by, state, sha256)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'posts.png', 'image/png', $5, $6,
         'upload', $3::uuid, $4::text, CASE WHEN $4::text <> 'pending_upload' THEN sha256(convert_to($1::text, 'UTF8')) END)`,
      [
        id,
        workspace,
        user("owner").id,
        state,
        ready ? (facts.width ?? 400) : null,
        ready ? (facts.height ?? 300) : null,
      ],
    );
    if (ready && facts.stripped !== false)
      await client.query(
        `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, sha256, byte_size)
         VALUES ($1::uuid, $2::uuid, 'stripped', 'ws/' || $1::text || '/' || $2::text || '/1/stripped', 'ready',
           sha256(convert_to($2::text || 'stripped', 'UTF8')), $3)`,
        [workspace, id, facts.bytes ?? 1000],
      );
  });
  return id;
}

beforeAll(async () => {
  fx = await startFixture({
    channels: {
      providers: {
        fixture_oauth: {
          adapter: createFixtureAdapter({ baseUrl: "http://127.0.0.1:1", clientId: "c" }),
          manifest,
        },
      },
      fetch,
      pepper: new SealedSecret(PEPPER),
    },
  });
  const founder = await signedUser(fx, "posts-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `posts-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
  c1 = await seedChannel(fx, ws, "connected", "posts-c1", "fixture_oauth");
  cOther = await seedChannel(fx, other, "connected", "posts-other", "fixture_oauth");
  media.ready = await plantMedia(ws, "ready");
  media.pending = await plantMedia(ws, "pending_upload");
  media.foreign = await plantMedia(other, "ready");
});
afterAll(() => fx.close());

const variant = (channel: string, change: object = {}) => ({
  channel_id: channel,
  locale: null,
  post_type: "text",
  text: "hello",
  parts: [] as object[],
  settings: {} as Record<string, unknown>,
  media: [] as object[],
  ...change,
});
const draftBody = (...variants: object[]) => ({ draft: { variants } });
const base = (workspace: string) => `/api/v1/workspaces/${workspace}/posts`;
const call = (
  who: User,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  fx.request(path, {
    method,
    headers: { cookie: who.cookie, ...headers },
    ...(body === undefined ? {} : { body }),
  });
const match = (version: string) => ({ "if-match": `"${version}"` });
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;
const errorOf = async (answer: Response) =>
  ((await answer.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

interface Planted {
  post: string;
  version: string;
}
// A post written as the superuser, so a test of the routes does not depend on the create route.
async function plant(workspace = ws, channel = c1, deleted = false): Promise<Planted> {
  const snapshot = {
    version: 1,
    draft: { variants: [variant(channel, { text: "planted" })] },
    resolved: {
      variants: [{ channel_id: channel, locale: null, settings: {} }],
      media: {},
      manifestDigest: {},
    },
  };
  return fx.admin(async (client) => {
    const post = (
      await client.query(
        "INSERT INTO app.posts (workspace_id, author_kind, author_id, deleted_at) VALUES ($1, 'user', $2, $3) RETURNING id",
        [workspace, user("owner").id, deleted ? new Date() : null],
      )
    ).rows[0].id as string;
    const version = (
      await client.query(
        `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
         VALUES ($1, $2, 1, 'save', $3::jsonb, decode(repeat('ab', 32), 'hex'), $4) RETURNING id`,
        [workspace, post, JSON.stringify(snapshot), user("owner").id],
      )
    ).rows[0].id as string;
    await client.query(
      "INSERT INTO app.post_variants (workspace_id, post_id, channel_id, text) VALUES ($1, $2, $3, 'planted')",
      [workspace, post, channel],
    );
    await client.query("UPDATE app.posts SET current_version_id = $2 WHERE id = $1", [post, version]);
    return { post, version };
  });
}
const versionsOf = (post: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          "SELECT id, version_no, snapshot_hash FROM app.post_versions WHERE post_id = $1 ORDER BY version_no",
          [post],
        )
      ).rows,
  );
const currentOf = (post: string) =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT current_version_id AS id FROM app.posts WHERE id = $1", [post])).rows[0]
        .id as string,
  );

describe("who may use the posts routes", () => {
  it.each(["owner", "admin", "editor"])(
    "%s creates, reads, autosaves, saves, lists and restores",
    async (seat) => {
      const who = user(seat);
      const made = await call(who, "POST", base(ws), draftBody(variant(c1)));
      const { id, version_id: first } = await dataOf(made.clone());
      const url = `${base(ws)}/${id}`;
      const got = await call(who, "GET", url);
      const auto = await call(
        who,
        "PATCH",
        url,
        draftBody(variant(c1, { text: "two" })),
        match(first as string),
      );
      const second = (await dataOf(auto.clone())).version_id as string;
      const saved = await call(
        who,
        "POST",
        `${url}/save`,
        draftBody(variant(c1, { text: "three" })),
        match(second),
      );
      const third = (await dataOf(saved.clone())).version_id as string;
      const list = await call(who, "GET", `${url}/versions`);
      const restored = await call(who, "POST", `${url}/versions/${first}/restore`, undefined, match(third));
      expect([made, got, auto, saved, list, restored].map((answer) => answer.status)).toEqual([
        201, 200, 200, 200, 200, 201,
      ]);
      expect(made.headers.get("etag")).toBe(`"${first}"`);
    },
  );
});

describe("who may only read, and who may not see the posts routes", () => {
  it.each(["approver", "viewer"])("%s reads (200) and is refused every write (403)", async (seat) => {
    const who = user(seat);
    const { post, version } = await plant();
    const url = `${base(ws)}/${post}`;
    const writes = [
      call(who, "POST", base(ws), draftBody(variant(c1))),
      call(who, "PATCH", url, draftBody(variant(c1)), match(version)),
      call(who, "POST", `${url}/save`, draftBody(variant(c1)), match(version)),
      call(who, "POST", `${url}/versions/${version}/restore`, undefined, match(version)),
    ];
    const reads = [call(who, "GET", url), call(who, "GET", `${url}/versions`)];
    expect((await Promise.all(reads)).map((answer) => answer.status)).toEqual([200, 200]);
    const refused = await Promise.all(writes);
    expect(refused.map((answer) => answer.status)).toEqual([403, 403, 403, 403]);
    expect(await Promise.all(refused.map(async (answer) => (await errorOf(answer)).code))).toEqual(
      Array(4).fill("forbidden"),
    );
  });

  it("a non-member gets 404 on all six routes", async () => {
    const { post, version } = await plant();
    const url = `${base(ws)}/${post}`;
    const who = user("outsider");
    const answers = await Promise.all([
      call(who, "POST", base(ws), draftBody(variant(c1))),
      call(who, "GET", url),
      call(who, "PATCH", url, draftBody(variant(c1)), match(version)),
      call(who, "POST", `${url}/save`, draftBody(variant(c1)), match(version)),
      call(who, "GET", `${url}/versions`),
      call(who, "POST", `${url}/versions/${version}/restore`, undefined, match(version)),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual(Array(6).fill(404));
  });
});

describe("a post is reached only through its own workspace", () => {
  it("a post of workspace A through B's path as B's owner: 404 everywhere, and A's rows unchanged", async () => {
    const { post, version } = await plant();
    const before = await versionsOf(post);
    const url = `${base(other)}/${post}`;
    const who = user("foreign");
    const answers = await Promise.all([
      call(who, "GET", url),
      call(who, "PATCH", url, draftBody(variant(cOther, { text: "taken" })), match(version)),
      call(who, "POST", `${url}/save`, draftBody(variant(cOther)), match(version)),
      call(who, "GET", `${url}/versions`),
      call(who, "POST", `${url}/versions/${version}/restore`, undefined, match(version)),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual(Array(5).fill(404));
    expect(await versionsOf(post)).toEqual(before);
    expect(await currentOf(post)).toBe(version);
  });

  it("a deleted post answers 404 on get, versions and every write", async () => {
    const { post, version } = await plant(ws, c1, true);
    const url = `${base(ws)}/${post}`;
    const who = user("editor");
    const answers = await Promise.all([
      call(who, "GET", url),
      call(who, "GET", `${url}/versions`),
      call(who, "PATCH", url, draftBody(variant(c1)), match(version)),
      call(who, "POST", `${url}/save`, draftBody(variant(c1)), match(version)),
      call(who, "POST", `${url}/versions/${version}/restore`, undefined, match(version)),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual(Array(5).fill(404));
    expect(await versionsOf(post)).toHaveLength(1);
  });
});

const MATCH_ROWS: [string, (current: string) => string | undefined, number, string][] = [
  ["a version that is not the current one", () => `"${randomUUID()}"`, 412, "precondition_failed"],
  ["no If-Match header", () => undefined, 428, "precondition_required"],
  ["a value that is not a uuid", () => '"not-a-version"', 400, "validation_failed"],
  ["an unquoted uuid", (current) => current, 400, "validation_failed"],
  ["the wildcard", () => "*", 400, "validation_failed"],
  ["a weak validator", (current) => `W/"${current}"`, 400, "validation_failed"],
  ["a list of versions", (current) => `"${current}", "${randomUUID()}"`, 400, "validation_failed"],
];

describe("If-Match on autosave, save and restore", () => {
  it.each(MATCH_ROWS)("%s", async (_what, header, status, code) => {
    const { post, version } = await plant();
    const value = header(version);
    const sent = value === undefined ? {} : { "if-match": value };
    for (const [method, path] of [
      ["PATCH", ""],
      ["POST", "/save"],
    ] as const) {
      const answer = await call(
        user("editor"),
        method,
        `${base(ws)}/${post}${path}`,
        draftBody(variant(c1, { text: "late" })),
        sent,
      );
      expect([answer.status, (await errorOf(answer)).code]).toEqual([status, code]);
    }
    expect(await versionsOf(post)).toHaveLength(1);
  });

  it("a stale autosave answers 412 with the current version id and keeps the newer version", async () => {
    const { post, version } = await plant();
    const url = `${base(ws)}/${post}`;
    const first = await call(
      user("editor"),
      "PATCH",
      url,
      draftBody(variant(c1, { text: "newer" })),
      match(version),
    );
    const newer = (await dataOf(first)).version_id as string;
    const stale = await call(
      user("editor"),
      "PATCH",
      url,
      draftBody(variant(c1, { text: "older" })),
      match(version),
    );
    expect(stale.status).toBe(412);
    expect((await errorOf(stale)).details).toEqual({ current_version_id: newer });
    expect(stale.headers.get("etag")).toBe(`"${newer}"`);
    expect(await versionsOf(post)).toHaveLength(2);
    const got = await dataOf(await call(user("editor"), "GET", url));
    expect(got.current_version_id).toBe(newer);
    expect((got.variants as { text: string }[])[0]?.text).toBe("newer");
  });
});

describe("a double submit", () => {
  it("of one autosave: one 200, one 412, one new version", async () => {
    const { post, version } = await plant();
    const send = () =>
      call(
        user("editor"),
        "PATCH",
        `${base(ws)}/${post}`,
        draftBody(variant(c1, { text: "twice" })),
        match(version),
      );
    const answers = await Promise.all([send(), send()]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 412]);
    expect(await versionsOf(post)).toHaveLength(2);
  });
});

describe("restore of a draft that no longer resolves", () => {
  it("restoring a version whose medium was deleted answers 422 media_unavailable and writes no version", async () => {
    const gone = await plantMedia(ws, "ready");
    const who = user("editor");
    const medium = { media_id: gone, alt_text: null, crop: null };
    const made = await call(who, "POST", base(ws), draftBody(variant(c1, { media: [medium] })));
    const { id, version_id: first } = await dataOf(made);
    const url = `${base(ws)}/${id}`;
    const edited = await call(who, "PATCH", url, draftBody(variant(c1)), match(first as string));
    const head = (await dataOf(edited)).version_id as string;
    await fx.admin((client) =>
      client.query("UPDATE app.media_assets SET state = 'deleted', deleted_at = now() WHERE id = $1", [gone]),
    );
    const restored = await call(who, "POST", `${url}/versions/${first}/restore`, undefined, match(head));
    const error = await errorOf(restored);
    expect([restored.status, error.code, error.details]).toEqual([
      422,
      "unprocessable_content",
      { reason: "media_unavailable" },
    ]);
    expect(await versionsOf(id as string)).toHaveLength(2);
    expect(await currentOf(id as string)).toBe(head);
  });
});

describe("restore", () => {
  it("answers 201 with a new version and its ETag, leaves old versions as they were, and refuses a stale head or another post's version", async () => {
    const { post, version } = await plant();
    const url = `${base(ws)}/${post}`;
    const edited = await call(
      user("editor"),
      "PATCH",
      url,
      draftBody(variant(c1, { text: "edited" })),
      match(version),
    );
    const head = (await dataOf(edited)).version_id as string;
    const before = await versionsOf(post);
    const restored = await call(
      user("editor"),
      "POST",
      `${url}/versions/${version}/restore`,
      undefined,
      match(head),
    );
    const made = (await dataOf(restored.clone())).version_id as string;
    expect(restored.status).toBe(201);
    expect(restored.headers.get("etag")).toBe(`"${made}"`);
    const after = await versionsOf(post);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after).toHaveLength(3);
    const stale = await call(
      user("editor"),
      "POST",
      `${url}/versions/${version}/restore`,
      undefined,
      match(head),
    );
    expect([stale.status, (await errorOf(stale)).code]).toEqual([412, "precondition_failed"]);
    const foreign = await plant();
    const wrong = await call(
      user("editor"),
      "POST",
      `${url}/versions/${foreign.version}/restore`,
      undefined,
      match(made),
    );
    expect(wrong.status).toBe(404);
  });
});

describe("no post text in any log line", () => {
  it("the canary text is in no log line across create, autosave, a 412 and a 422", async () => {
    const canary = `canary-post-text-${randomUUID()}`;
    const who = user("editor");
    const made = await call(who, "POST", base(ws), draftBody(variant(c1, { text: canary })));
    const { id, version_id: first } = await dataOf(made);
    await call(
      who,
      "PATCH",
      `${base(ws)}/${id}`,
      draftBody(variant(c1, { text: `${canary}-2` })),
      match(first as string),
    );
    await call(
      who,
      "PATCH",
      `${base(ws)}/${id}`,
      draftBody(variant(c1, { text: `${canary}-3` })),
      match(first as string),
    );
    await call(who, "POST", base(ws), draftBody(variant(c1, { text: canary, settings: { nope: 1 } })));
    expect(leaks(fx.logged.join("\n"), [canary])).toEqual([]);
  });
});

const OVER = "x".repeat(10);
const REFUSAL_ROWS: [string, () => unknown, number, string | undefined, string][] = [
  [
    "a settings key the channel does not declare",
    () => draftBody(variant(c1, { settings: { nope: 1 } })),
    422,
    "settings_undeclared",
    "unprocessable_content",
  ],
  [
    "a setting of the wrong type",
    () => draftBody(variant(c1, { settings: { max_length: OVER } })),
    422,
    "settings_type",
    "unprocessable_content",
  ],
  [
    "a channel that does not exist",
    () => draftBody(variant(randomUUID())),
    422,
    "unknown_channel",
    "unprocessable_content",
  ],
  [
    "a channel of another workspace",
    () => draftBody(variant(cOther)),
    422,
    "unknown_channel",
    "unprocessable_content",
  ],
  [
    "media of another workspace",
    () => draftBody(variant(c1, { media: [{ media_id: media.foreign, alt_text: null, crop: null }] })),
    422,
    "media_unavailable",
    "unprocessable_content",
  ],
  [
    "media that is still pending upload",
    () => draftBody(variant(c1, { media: [{ media_id: media.pending, alt_text: null, crop: null }] })),
    422,
    "media_unavailable",
    "unprocessable_content",
  ],
  [
    "an unknown key beside the draft",
    () => ({ ...draftBody(variant(c1)), extra: 1 }),
    400,
    undefined,
    "validation_failed",
  ],
  ["no draft at all", () => ({}), 400, undefined, "validation_failed"],
];

const attach = (...ids: string[]) =>
  draftBody(variant(c1, { media: ids.map((media_id) => ({ media_id, alt_text: null, crop: null })) }));
const refusedDetails = async (answer: Response) => [
  answer.status,
  ((await answer.json()) as { error?: { details?: unknown } }).error?.details,
];

describe("only ready media is attached, and only media the channel's rule takes (BG-8)", () => {
  const STATES: [string, () => Promise<string>][] = [
    ["uploaded", () => plantMedia(ws, "uploaded")],
    ["processing", () => plantMedia(ws, "processing")],
    ["rejected", () => plantMedia(ws, "rejected")],
    ["deleted", () => plantMedia(ws, "deleted")],
    ["ready without a stripped derivative", () => plantMedia(ws, "ready", { stripped: false })],
    ["ready in another workspace", () => plantMedia(other, "ready")],
  ];
  it.each(STATES)("a medium that is %s is refused at create", async (_name, plant) => {
    const answer = await call(user("editor"), "POST", base(ws), attach(await plant()));
    expect(await refusedDetails(answer)).toEqual([422, { reason: "media_unavailable" }]);
  });

  it("a ready medium with its facts is taken, at create and at autosave", async () => {
    const who = user("editor");
    const made = await call(who, "POST", base(ws), attach(await plantMedia(ws, "ready")));
    expect(made.status).toBe(201);
    const { id, version_id: first } = await dataOf(made);
    const saved = await call(who, "PATCH", `${base(ws)}/${id}`, attach(media.ready), match(first as string));
    expect(saved.status).toBe(200);
  });

  it("autosave refuses a medium that is still processing", async () => {
    const who = user("editor");
    const { id, version_id: first } = await dataOf(await call(who, "POST", base(ws), draftBody(variant(c1))));
    const answer = await call(
      who,
      "PATCH",
      `${base(ws)}/${id}`,
      attach(await plantMedia(ws, "processing")),
      match(first as string),
    );
    expect(await refusedDetails(answer)).toEqual([422, { reason: "media_unavailable" }]);
  });

  // The fixture manifest allows 5 MiB, 25 MP and 4 media: a medium ready and valid at upload but outside the rule of the
  // channel it is attached to is refused now, not at publish; the reason of the rule is named beside the code.
  const RULES: [string, () => Promise<string[]>, string][] = [
    ["over imageMaxBytes", async () => [await plantMedia(ws, "ready", { bytes: 5_242_881 })], "too_large"],
    [
      "over imageMaxPixels",
      async () => [await plantMedia(ws, "ready", { width: 5001, height: 5000 })],
      "pixel_limit",
    ],
    [
      "a fifth medium over mediaMaxCount",
      async () => Promise.all([1, 2, 3, 4, 5].map(() => plantMedia(ws, "ready"))),
      "too_many",
    ],
  ];
  it.each(RULES)("media %s is refused at create with the rule named", async (_name, plant, rule) => {
    const answer = await call(user("editor"), "POST", base(ws), attach(...(await plant())));
    expect(await refusedDetails(answer)).toEqual([422, { reason: "media_unavailable", rule }]);
  });
});

describe("a draft the server refuses", () => {
  it.each(REFUSAL_ROWS)("%s", async (_what, body, status, reason, code) => {
    const answer = await call(user("editor"), "POST", base(ws), body());
    const text = await answer.text();
    expect(answer.status).toBe(status);
    const error = (
      JSON.parse(text) as { error: { code: string; details?: { reason?: string; issues?: unknown[] } } }
    ).error;
    expect(error.code).toBe(code);
    if (reason) expect(error.details?.reason).toBe(reason);
    expect(text).not.toContain(OVER);
  });

  it("an undeclared key and a wrong-typed value are listed as issues without the value", async () => {
    const answer = await call(
      user("editor"),
      "POST",
      base(ws),
      draftBody(variant(c1, { settings: { nope: 1, max_length: OVER } })),
    );
    const issues = (await errorOf(answer)).details?.issues;
    expect(issues).toEqual([
      { variant: 0, key: "nope", reason: "undeclared" },
      { variant: 0, key: "max_length", reason: "type" },
    ]);
  });

  it("lists at most 20 issues and says when it cut the list", async () => {
    const settings = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`nope${i}`, 1]));
    const answer = await call(user("editor"), "POST", base(ws), draftBody(variant(c1, { settings })));
    const details = (await errorOf(answer)).details as { issues?: unknown[]; truncated?: boolean };
    expect(details.issues).toHaveLength(20);
    expect(details.truncated).toBe(true);
  });

  it("a body that is not JSON answers 415", async () => {
    const answer = await call(user("editor"), "POST", base(ws), draftBody(variant(c1)), {
      "content-type": "text/plain",
    });
    expect(answer.status).toBe(415);
  });
});

// The exact byte limits, as PostgreSQL measures the stored jsonb text: the limit is accepted and core's count equals the
// database's, one byte more is refused with an answer (never a 500).
const sized = (target: number, make: (pads: string[]) => unknown, slots = 1): unknown => {
  const base = jsonbBytes(make(Array(slots).fill(""))) as number;
  const each = Math.floor((target - base) / slots);
  const extra = (target - base) % slots;
  return make(Array.from({ length: slots }, (_, i) => "a".repeat(each + (i < extra ? 1 : 0))));
};
const snapshotBytes = (variants: ReturnType<typeof variant>[]) =>
  jsonbBytes(
    {
      version: 1,
      draft: { variants },
      resolved: {
        variants: variants.map((v) => ({
          channel_id: v.channel_id,
          locale: v.locale,
          settings: { ...DEFAULTS, ...v.settings },
        })),
        media: {},
        manifestDigest: { [variants[0]?.channel_id as string]: DIGEST },
      },
    },
    Number.POSITIVE_INFINITY,
  ) as number;
const manyVariants = (target: number) => {
  const slots = 11;
  const build = (pads: string[]) => pads.map((pad, i) => variant(c1, { locale: `l${i}`, text: pad }));
  const base = snapshotBytes(build(Array(slots).fill("")));
  const each = Math.floor((target - base) / slots);
  const extra = (target - base) % slots;
  return build(Array.from({ length: slots }, (_, i) => "a".repeat(each + (i < extra ? 1 : 0))));
};

interface Limit {
  name: string;
  limit: number;
  /** The answer one byte over: a bound the document itself checks is a 400, the snapshot is the server's 422. */
  over: { status: number; code: string; reason?: string };
  build: (bytes: number) => { variants: object[]; value: unknown };
  column: string;
}
const LIMITS: Limit[] = [
  {
    name: "parts",
    limit: 262144,
    over: { status: 400, code: "validation_failed" },
    build: (bytes) => {
      const parts = sized(bytes, (pads) => pads.map((text) => ({ kind: "thread_reply", text })), 3);
      return { variants: [variant(c1, { parts })], value: parts };
    },
    column: "SELECT octet_length(parts::text) AS n FROM app.post_variants WHERE post_id = $1",
  },
  {
    name: "settings",
    limit: 65536,
    over: { status: 400, code: "validation_failed" },
    build: (bytes) => {
      const settings = sized(bytes, ([pad]) => ({ tag: pad })) as Record<string, unknown>;
      return { variants: [variant(c1, { settings })], value: settings };
    },
    column: "SELECT octet_length(settings::text) AS n FROM app.post_variants WHERE post_id = $1",
  },
  {
    name: "crop",
    limit: 1024,
    over: { status: 400, code: "validation_failed" },
    build: (bytes) => {
      const crop = sized(bytes, ([pad]) => ({ k: pad }));
      return {
        variants: [variant(c1, { media: [{ media_id: media.ready, alt_text: null, crop }] })],
        value: crop,
      };
    },
    column:
      "SELECT octet_length(m.crop::text) AS n FROM app.post_media m JOIN app.post_variants v ON v.id = m.variant_id WHERE v.post_id = $1",
  },
  {
    name: "snapshot",
    limit: 1048576,
    over: { status: 422, code: "unprocessable_content", reason: "snapshot_too_large" },
    build: (bytes) => {
      const variants = manyVariants(bytes);
      return { variants, value: { version: 1, snapshot: variants } };
    },
    column: "SELECT octet_length(snapshot::text) AS n FROM app.post_versions WHERE post_id = $1",
  },
];

describe("exact limits", () => {
  it.each(LIMITS)(
    "$name: the limit is stored and counted the same, one byte over is refused",
    async (row) => {
      const at = row.build(row.limit);
      const accepted = await call(user("editor"), "POST", base(ws), { draft: { variants: at.variants } });
      expect(accepted.status).toBe(201);
      const post = (await dataOf(accepted)).id as string;
      const stored = await fx.admin(
        async (client) => (await client.query(row.column, [post])).rows[0].n as number,
      );
      expect(stored).toBe(row.limit);
      if (row.name !== "snapshot") expect(jsonbBytes(at.value)).toBe(stored);
      const over = row.build(row.limit + 1);
      const refused = await call(user("editor"), "POST", base(ws), { draft: { variants: over.variants } });
      const error = await errorOf(refused);
      expect([refused.status, error.code]).toEqual([row.over.status, row.over.code]);
      if (row.over.reason) expect(error.details).toMatchObject({ reason: row.over.reason });
    },
  );
});

describe("what a create stores", () => {
  it("the snapshot holds the resolved block and its hash is the hash of that snapshot", async () => {
    const answer = await call(
      user("editor"),
      "POST",
      base(ws),
      draftBody(
        variant(c1, {
          settings: { max_length: 100 },
          media: [{ media_id: media.ready, alt_text: "alt", crop: null }],
        }),
      ),
    );
    const post = (await dataOf(answer)).id as string;
    const row = await fx.admin(
      async (client) =>
        (
          await client.query("SELECT snapshot, snapshot_hash FROM app.post_versions WHERE post_id = $1", [
            post,
          ])
        ).rows[0],
    );
    const resolved = row.snapshot.resolved;
    expect(resolved.variants).toEqual([
      { channel_id: c1, locale: null, settings: { ...DEFAULTS, max_length: 100 } },
    ]);
    expect(resolved.media).toEqual({ [media.ready]: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(resolved.manifestDigest).toEqual({ [c1]: DIGEST });
    expect(row.snapshot_hash.toString("hex")).toBe(snapshotHash(row.snapshot).toString("hex"));
  });
});

describe("the versions of a post", () => {
  it("lists newest first without the snapshot, and pages by cursor", async () => {
    const { post, version } = await plant();
    const url = `${base(ws)}/${post}`;
    const second = (
      await dataOf(
        await call(user("editor"), "PATCH", url, draftBody(variant(c1, { text: "2" })), match(version)),
      )
    ).version_id as string;
    const third = (
      await dataOf(
        await call(user("editor"), "PATCH", url, draftBody(variant(c1, { text: "3" })), match(second)),
      )
    ).version_id as string;
    const page = await call(user("viewer"), "GET", `${url}/versions?limit=2`);
    const body = (await page.json()) as {
      data: Record<string, unknown>[];
      meta: { next_cursor: string | null };
    };
    expect(body.data.map((v) => v.id)).toEqual([third, second]);
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      "created_at",
      "created_by",
      "id",
      "kind",
      "version_no",
    ]);
    const rest = await call(user("viewer"), "GET", `${url}/versions?limit=2&cursor=${body.meta.next_cursor}`);
    expect(((await rest.json()) as { data: { id: string }[] }).data.map((v) => v.id)).toEqual([version]);
  });
});
