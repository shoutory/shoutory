import { randomUUID } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
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

type User = { id: string; cookie: string };
const SEATS = ["owner", "editor", "viewer"] as const;
const manifest = manifestSchema.parse(fixtureOAuthManifest);
const CANARY = "canary-provider-words-1";
let fx: Fixture;
let ws: string;
let other: string;
let c1: string;
let c2: string;
let cOther: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};

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
  const founder = await signedUser(fx, "plist-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "foreign"]) users[name] = await signedUser(fx, `plist-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
  c1 = await seedChannel(fx, ws, "connected", "plist-c1", "fixture_oauth");
  c2 = await seedChannel(fx, ws, "connected", "plist-c2", "fixture_oauth");
  cOther = await seedChannel(fx, other, "connected", "plist-other", "fixture_oauth");
});
afterAll(async () => {
  await fx.close();
});

interface TargetSpec {
  channel?: string;
  state?: string;
  published?: boolean;
  held?: boolean;
  operation?: string;
}
interface Spec {
  workspace?: string;
  text?: string | null;
  status?: string;
  updated?: Date;
  deleted?: boolean;
  targets?: TargetSpec[];
}
interface Planted {
  post: string;
  version: string;
}

// The rows are written as stored facts, past the triggers that keep them in step, so each case names its own shape.
async function plant(spec: Spec = {}): Promise<Planted> {
  const workspace = spec.workspace ?? ws;
  const targets = spec.targets ?? [{ channel: workspace === ws ? c1 : cOther }];
  const text = spec.text === undefined ? "a post" : spec.text;
  const heldMedia = randomUUID();
  const snapshot = (words: string | null, media: object = {}) => ({
    version: 1,
    draft: { variants: words === null ? [] : [{ channel_id: targets[0]?.channel, text: words }] },
    resolved: { variants: [], media, manifestDigest: {} },
  });
  return fx.admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const post = (
      await client.query(
        `INSERT INTO app.posts (workspace_id, author_kind, author_id, status, updated_at, deleted_at)
         VALUES ($1, 'user', $2, $3, $4, $5) RETURNING id`,
        [
          workspace,
          user("owner").id,
          spec.status ?? "draft",
          spec.updated ?? new Date(),
          spec.deleted ? new Date() : null,
        ],
      )
    ).rows[0].id as string;
    const insertVersion = async (no: number, content: object) =>
      (
        await client.query(
          `INSERT INTO app.post_versions (workspace_id, post_id, version_no, kind, snapshot, snapshot_hash, created_by)
           VALUES ($1, $2, $3, 'save', $4::jsonb, decode(repeat('ab', 32), 'hex'), $5) RETURNING id`,
          [workspace, post, no, JSON.stringify(content), user("owner").id],
        )
      ).rows[0].id as string;
    await insertVersion(1, snapshot("an earlier text"));
    const version = await insertVersion(
      2,
      snapshot(text, targets.some((t) => t.held) ? { [heldMedia]: "ab" } : {}),
    );
    await client.query("UPDATE app.posts SET current_version_id = $2 WHERE id = $1", [post, version]);
    for (const target of targets) await plantTarget(client, { workspace, post, version }, target);
    await client.query("COMMIT");
    return { post, version };
  });
}

type Admin = Parameters<Parameters<Fixture["admin"]>[0]>[0];
async function plantTarget(
  client: Admin,
  at: { workspace: string; post: string; version: string },
  target: TargetSpec,
): Promise<void> {
  const channel = target.channel ?? c1;
  const variant = (
    await client.query(
      `INSERT INTO app.post_variants (workspace_id, post_id, channel_id, text, schedule_state, local_due, due_tz,
         due_at, frozen_version_id, published_at)
       VALUES ($1, $2, $3, 'the variant table text', $4, '2099-01-05 09:00', 'UTC', '2099-01-05T09:00:00Z',
         CASE WHEN $4 = 'draft' THEN NULL ELSE $5::uuid END, CASE WHEN $6::boolean THEN now() END) RETURNING id`,
      [at.workspace, at.post, channel, target.state ?? "draft", at.version, target.published ?? false],
    )
  ).rows[0].id as string;
  if (target.operation === undefined) return;
  const op = (
    await client.query(
      `INSERT INTO app.operations (workspace_id, variant_id, channel_id, provider_id, queue, kind, state, effect,
         last_actor, due_at, lateness_deadline, idempotency_marker, frozen_version_id,
         frozen_snapshot_hash, requested_by, lease_seconds, fencing_token)
       VALUES ($1, $2, $3, 'fixture_oauth', 'publish.fixture_oauth', 'publish', $4, 'possible', 'S', now(),
         now() + interval '2 hours', $5, $6, decode(repeat('ab', 32), 'hex'), $7, 60, 1) RETURNING id`,
      [at.workspace, variant, channel, target.operation, `m-${randomUUID()}`, at.version, user("owner").id],
    )
  ).rows[0].id as string;
  await client.query(
    `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, effect,
       http_status, error_class, provider_code, response_excerpt)
     VALUES ($1, $2, 1, 'commit', 1, 'possible', 502, 'server', $3, $3)`,
    [at.workspace, op, CANARY],
  );
}

const list = (who: User, query = "", workspace = ws) =>
  fx.request(`/api/v1/workspaces/${workspace}/posts${query}`, { headers: { cookie: who.cookie } });
type Row = Record<string, unknown> & { id: string; targets: Record<string, unknown>[] };
const pageOf = async (answer: Response) =>
  (await answer.json()) as { data: Row[]; meta: { next_cursor: string | null } };
const idsOf = async (answer: Response) => (await pageOf(answer)).data.map((row) => row.id);

describe("the posts list", () => {
  it("pages newest first by update time then id, resumes from a cursor and ends with no cursor", async () => {
    const marker = new Date("2031-01-01T00:00:00Z");
    const at = (minutes: number) => new Date(marker.getTime() + minutes * 60_000);
    const oldest = await plant({ updated: at(0) });
    const tieA = await plant({ updated: at(5) });
    const tieB = await plant({ updated: at(5) });
    const newest = await plant({ updated: at(9) });
    const [tieLow, tieHigh] = [tieA.post, tieB.post].sort();
    const first = await pageOf(await list(user("viewer"), "?limit=2"));
    expect(first.data.map((row) => row.id)).toEqual([newest.post, tieHigh]);
    const second = await pageOf(await list(user("viewer"), `?limit=2&cursor=${first.meta.next_cursor}`));
    expect(second.data.map((row) => row.id)).toEqual([tieLow, oldest.post]);
  });

  it("ends the last page with no cursor", async () => {
    const page = await pageOf(await list(user("viewer"), "?limit=100"));
    expect(page.meta.next_cursor).toBeNull();
  });

  it("answers a cursor that is unknown or another workspace's post with an empty page", async () => {
    const foreign = await plant({ workspace: other });
    for (const cursor of [randomUUID(), foreign.post]) {
      const answer = await list(user("viewer"), `?cursor=${cursor}`);
      expect(answer.status).toBe(200);
      expect(await pageOf(answer)).toMatchObject({ data: [], meta: { next_cursor: null } });
    }
  });

  it("never shows another workspace's post, and a member of that workspace gets 404 on this path", async () => {
    const mine = await plant();
    const foreign = await plant({ workspace: other });
    const ids = await idsOf(await list(user("viewer"), "?limit=100"));
    expect(ids).toContain(mine.post);
    expect(ids).not.toContain(foreign.post);
    expect(await idsOf(await list(user("foreign"), "?limit=100", other))).toContain(foreign.post);
    expect((await list(user("foreign"))).status).toBe(404);
  });

  it("excludes deleted posts", async () => {
    const gone = await plant({ deleted: true });
    expect(await idsOf(await list(user("viewer"), "?limit=100"))).not.toContain(gone.post);
  });

  it.each(["owner", "editor", "viewer"])("a %s reads the list", async (seat) => {
    expect((await list(user(seat))).status).toBe(200);
  });
});

describe("what a posts list row shows", () => {
  it("filters by one status and refuses a status that does not exist", async () => {
    const failed = await plant({ status: "failed" });
    const draft = await plant({ status: "draft" });
    const ids = await idsOf(await list(user("viewer"), "?status=failed&limit=100"));
    expect(ids).toContain(failed.post);
    expect(ids).not.toContain(draft.post);
    const refused = await list(user("viewer"), "?status=bogus");
    expect(refused.status).toBe(400);
  });

  it.each([
    ["a short text", "hello", "hello"],
    ["a text of 200 astral characters", "😀".repeat(200), "😀".repeat(140)],
    ["a draft with no variant", null, null],
  ])("the excerpt of %s is taken from the current version", async (_name, text, excerpt) => {
    const planted = await plant({ text });
    const row = (await pageOf(await list(user("viewer"), "?limit=100"))).data.find(
      (r) => r.id === planted.post,
    );
    expect(row?.excerpt).toBe(excerpt);
    expect(row?.current_version_id).toBe(planted.version);
  });
});

describe("the targets of a posts list row", () => {
  it("answers each post with its targets, the held reason and the counts, and nothing else", async () => {
    const planted = await plant({
      status: "partially_published",
      targets: [
        { channel: c1, state: "settled", published: true, operation: "published" },
        { channel: c2, state: "scheduled", held: true },
      ],
    });
    const row = (await pageOf(await list(user("viewer"), "?status=partially_published&limit=100"))).data.find(
      (r) => r.id === planted.post,
    );
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "author_id",
      "author_kind",
      "current_version_id",
      "excerpt",
      "id",
      "published_count",
      "status",
      "target_count",
      "targets",
      "updated_at",
    ]);
    expect(row).toMatchObject({ published_count: 1, target_count: 2, author_kind: "user" });
    const byChannel = new Map(row?.targets.map((t) => [t.channel_id, t]));
    expect(byChannel.get(c1)).toMatchObject({
      schedule_state: "settled",
      presence: "present",
      due_tz: "UTC",
      hold_reason: null,
      operation_state: "published",
    });
    expect(byChannel.get(c2)).toMatchObject({
      schedule_state: "scheduled",
      hold_reason: "held_media",
      operation_state: null,
    });
    for (const target of row?.targets ?? []) {
      expect(Object.keys(target).sort()).toEqual([
        "channel_id",
        "due_at",
        "due_tz",
        "hold_reason",
        "operation_state",
        "presence",
        "published_at",
        "schedule_state",
        "variant_id",
      ]);
    }
  });
});

describe("what a posts list never carries", () => {
  it("carries no provider word, code or error body, in any encoding", async () => {
    await plant({ targets: [{ channel: c1, state: "scheduled", operation: "failed" }] });
    const text = await (await list(user("viewer"), "?limit=100")).text();
    expect(text).toContain('"operation_state":"failed"');
    expect(leaks(text, [CANARY, "the variant table text"])).toEqual([]);
    for (const field of ["provider", "response", "reason_code", "error"]) expect(text).not.toContain(field);
  });
});

describe("one version of a post", () => {
  const version = (who: User, post: string, id: string, workspace = ws) =>
    fx.request(`/api/v1/workspaces/${workspace}/posts/${post}/versions/${id}`, {
      headers: { cookie: who.cookie },
    });

  it.each(["owner", "viewer"])("a %s gets the version with its draft and nothing else", async (seat) => {
    const planted = await plant({ text: "the draft text" });
    const answer = await version(user(seat), planted.post, planted.version);
    expect(answer.status).toBe(200);
    const { data } = (await answer.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual([
      "created_at",
      "created_by",
      "draft",
      "id",
      "kind",
      "version_no",
    ]);
    expect(data).toMatchObject({
      id: planted.version,
      version_no: 2,
      kind: "save",
      created_by: user("owner").id,
      draft: { variants: [{ channel_id: c1, text: "the draft text" }] },
    });
  });

  it("answers 404 for an unknown version, another post's version, and another workspace's post or version", async () => {
    const mine = await plant();
    const second = await plant();
    const foreign = await plant({ workspace: other });
    const missing = await version(user("viewer"), mine.post, randomUUID());
    const wrongPost = await version(user("viewer"), mine.post, second.version);
    const foreignPost = await version(user("viewer"), foreign.post, foreign.version);
    const foreignPath = await version(user("foreign"), foreign.post, foreign.version);
    for (const answer of [missing, wrongPost, foreignPost, foreignPath]) {
      expect(answer.status).toBe(404);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });
});
