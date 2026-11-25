import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageDriver } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
let fx: Fixture;
let root: string;
let storage: StorageDriver;
let ws: string;
let other: string;
const users: Record<string, User> = {};
const user = (name: string): User => {
  const found = users[name];
  if (!found) throw new Error(`no user ${name}`);
  return found;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "shoutory-media-library-"));
  storage = createFsDriver(root);
  fx = await startFixture({ storage });
  const founder = await signedUser(fx, "library-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `library-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await fx.close();
  await rm(root, { recursive: true, force: true });
});

const SAME_HASH = "ab".repeat(32);
const bytesOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

// A ready medium with its two derivatives in storage, and the original too, so a route that served the original
// instead of a derivative would be seen.
async function plantReady(
  workspace: string,
  mime = "image/png",
  sha: string = randomUUID(),
): Promise<string> {
  const id = randomUUID();
  const key = (profile: string) => `ws/${workspace}/${id}/1/${profile}`;
  await fx.admin(async (client) => {
    await client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, byte_size, source, created_by, state,
         sha256, codec_facts)
       VALUES ($1, $2, $3, 'library.png', $4, 8, 'upload', $5, 'ready',
         CASE WHEN $6 ~ '^[0-9a-f]{64}$' THEN decode($6, 'hex') ELSE sha256(convert_to($6, 'UTF8')) END,
         '{"codec": "planted-codec"}')`,
      [id, workspace, key("original"), mime, user("editor").id, sha],
    );
    for (const profile of ["stripped", "thumb"])
      await client.query(
        `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key, state, sha256, byte_size)
         VALUES ($1, $2, $3, $4, 'ready', sha256(convert_to($4, 'UTF8')), 8)`,
        [workspace, id, profile, key(profile)],
      );
  });
  for (const profile of ["original", "stripped", "thumb"])
    await storage.put(key(profile), bytesOf(`${profile}-bytes`), 1024);
  return id;
}

const base = (workspace: string) => `/api/v1/workspaces/${workspace}/media`;
const send = (who: User | null, method: string, path: string, body?: unknown) =>
  fx.request(path, {
    method,
    headers: who ? { cookie: who.cookie } : {},
    ...(body === undefined ? {} : { body }),
  });
const idsOf = async (answer: Response) =>
  ((await answer.json()) as { data: { id: string }[] }).data.map((row) => row.id);

type Route = [name: string, method: string, path: (workspace: string, id: string) => string, body?: unknown];
const ROUTES: Route[] = [
  ["get", "GET", (w, id) => `${base(w)}/${id}`],
  ["thumb", "GET", (w, id) => `${base(w)}/${id}/derivatives/thumb`],
  ["stripped", "GET", (w, id) => `${base(w)}/${id}/derivatives/stripped`],
  ["patch", "PATCH", (w, id) => `${base(w)}/${id}`, { tags: ["floor"] }],
  ["delete", "DELETE", (w, id) => `${base(w)}/${id}`],
];

describe("each route answers 404 for another workspace's medium and the list never holds its rows (floor)", () => {
  it.each(ROUTES)(
    "%s of a foreign medium through the caller's own workspace is 404",
    async (_n, method, path, body) => {
      const foreign = await plantReady(other);
      const answer = await send(user("owner"), method, path(ws, foreign), body);
      expect(answer.status).toBe(404);
      const row = (
        await fx.admin((client) =>
          client.query("SELECT state, tags FROM app.media_assets WHERE id = $1", [foreign]),
        )
      ).rows[0];
      expect(row).toEqual({ state: "ready", tags: [] });
    },
  );

  it("the same file in two workspaces stays two media, and each list holds only its own", async () => {
    const own = await plantReady(ws, "image/png", SAME_HASH);
    const foreign = await plantReady(other, "image/png", SAME_HASH);
    const listed = await idsOf(await send(user("owner"), "GET", `${base(ws)}?limit=100`));
    expect(listed).toContain(own);
    expect(listed).not.toContain(foreign);
  });
});

describe("who may use each route (floor)", () => {
  const READS = new Set(["list", "get", "thumb", "stripped"]);
  const ALL: Route[] = [["list", "GET", (w) => base(w)], ...ROUTES];
  const WHO: [string, () => User | null, (route: string) => number][] = [
    ["a viewer", () => user("viewer"), (route) => (READS.has(route) ? 200 : 403)],
    ["an approver", () => user("approver"), (route) => (READS.has(route) ? 200 : 403)],
    ["an editor", () => user("editor"), () => 200],
    ["a signed-in non-member", () => user("outsider"), () => 404],
    ["no session", () => null, () => 401],
  ];
  const cases = WHO.flatMap(([who, as, status]) =>
    ALL.map(([route, method, path, body]) => ({ who, as, route, method, path, body, status: status(route) })),
  );
  it.each(cases)("$who on $route answers $status", async ({ as, method, path, body, status }) => {
    const id = await plantReady(ws);
    const answer = await send(as(), method, path(ws, id), body);
    expect(answer.status === 204 ? 200 : answer.status).toBe(status);
  });
});

describe("answers carry no storage key, uploader, codec facts or deletion stamp (floor)", () => {
  it("list, get and patch answers hold none of the hidden columns or their values", async () => {
    const id = await plantReady(ws);
    const answers = [
      await send(user("editor"), "GET", `${base(ws)}?limit=100`),
      await send(user("editor"), "GET", `${base(ws)}/${id}`),
      await send(user("editor"), "PATCH", `${base(ws)}/${id}`, { file_name: "renamed.png" }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const text = await answer.text();
      for (const hidden of ["object_key", "created_by", "codec_facts", "deleted_at", "planted-codec"])
        expect(text).not.toContain(hidden);
      expect(text).not.toContain(`ws/${ws}/`);
      expect(text).not.toContain(user("editor").id);
      expect(text).not.toContain(root);
    }
  });
});

describe("the derivative route serves only a derivative, with a fixed type, nosniff and a sandbox (floor)", () => {
  it.each([
    ["thumb of an image", "image/png", "thumb", "image/webp", "thumb-bytes"],
    ["stripped copy of an image", "image/png", "stripped", "image/png", "stripped-bytes"],
    ["stripped copy of a video", "video/mp4", "stripped", "video/mp4", "stripped-bytes"],
    [
      "stripped copy whose type is not a media type",
      "text/html",
      "stripped",
      "application/octet-stream",
      "stripped-bytes",
    ],
  ])("the %s", async (_what, mime, profile, type, bytes) => {
    const id = await plantReady(ws, mime);
    const answer = await send(user("viewer"), "GET", `${base(ws)}/${id}/derivatives/${profile}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe(type);
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("content-security-policy")).toBe("sandbox");
    expect(await answer.text()).toBe(bytes);
  });

  it.each(["original", "small", "..%2Foriginal"])("the profile %s is not served", async (profile) => {
    const id = await plantReady(ws);
    const answer = await send(user("viewer"), "GET", `${base(ws)}/${id}/derivatives/${profile}`);
    expect([400, 404]).toContain(answer.status);
    expect(await answer.text()).not.toContain("original-bytes");
  });

  it.each([
    ["the thumbnail of a video, which has none", "video/mp4", "ready", "thumb"],
    ["a copy of a medium that is not ready", "image/png", "processing", "stripped"],
  ])("%s answers 404", async (_what, mime, state, profile) => {
    const id = await plantReady(ws, mime);
    await fx.admin(async (client) => {
      await client.query("UPDATE app.media_assets SET state = $2 WHERE id = $1", [id, state]);
      if (mime.startsWith("video/"))
        await client.query("DELETE FROM app.media_derivatives WHERE media_id = $1 AND profile = 'thumb'", [
          id,
        ]);
    });
    const answer = await send(user("viewer"), "GET", `${base(ws)}/${id}/derivatives/${profile}`);
    expect(answer.status).toBe(404);
  });
});

interface Shape {
  state?: string;
  mime?: string;
  file_name?: string;
  tags?: string[];
  in_library?: boolean;
}
async function plant(shape: Shape, sha?: string): Promise<string> {
  const id = await plantReady(ws, shape.mime ?? "image/png", sha);
  await fx.admin((client) =>
    client.query(
      `UPDATE app.media_assets SET state = coalesce($2, state), file_name = coalesce($3, file_name),
         tags = coalesce($4, tags), in_library = coalesce($5, in_library) WHERE id = $1`,
      [id, shape.state ?? null, shape.file_name ?? null, shape.tags ?? null, shape.in_library ?? null],
    ),
  );
  return id;
}
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;
const reasonOf = async (answer: Response) =>
  ((await answer.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

describe("the library list", () => {
  const TAG = "list-run";
  const planted: Record<string, string> = {};
  beforeAll(async () => {
    const tags = [TAG];
    planted.image = await plant({ file_name: "a_100%.png", tags, in_library: true });
    planted.video = await plant({ mime: "video/mp4", file_name: "b.mp4", tags });
    planted.rejected = await plant({ state: "rejected", file_name: "c.png", tags });
    planted.pending = await plant({ state: "pending_upload", file_name: "d.png", tags });
    await plant({ state: "deleted", file_name: "e.png", tags });
  });
  const newestFirst = (...names: string[]) =>
    names
      .map((name) => planted[name] as string)
      .sort()
      .reverse();
  const listed = async (filter: string) =>
    idsOf(await send(user("viewer"), "GET", `${base(ws)}?tag=${TAG}${filter}`));

  it.each([
    ["no other filter lists every medium but the deleted one", "", ["image", "video", "rejected", "pending"]],
    ["a search matches % and _ as themselves", `&q=${encodeURIComponent("_100%")}`, ["image"]],
    ["type", "&type=video", ["video"]],
    ["state", "&state=rejected", ["rejected"]],
    ["in_library", "&in_library=true", ["image"]],
  ])("%s", async (_what, filter, names) => {
    expect(await listed(filter)).toEqual(newestFirst(...names));
  });

  it("pages by cursor, newest first, to the end", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      const answer = await send(user("viewer"), "GET", `${base(ws)}?tag=${TAG}&limit=2${cursor}`);
      const body = (await answer.json()) as { data: { id: string }[]; meta: { next_cursor: string | null } };
      seen.push(...body.data.map((row) => row.id));
      if (body.meta.next_cursor === null) break;
      cursor = `&cursor=${body.meta.next_cursor}`;
    }
    expect(seen).toEqual(newestFirst("image", "video", "rejected", "pending"));
  });

  it("refuses the deleted state as a filter", async () => {
    expect((await send(user("viewer"), "GET", `${base(ws)}?state=deleted`)).status).toBe(400);
  });
});

describe("one medium", () => {
  it.each([
    ["pending_upload", 200],
    ["rejected", 200],
    ["deleted", 404],
  ])("a medium in state %s answers %i", async (state, status) => {
    const id = await plant({ state });
    const answer = await send(user("viewer"), "GET", `${base(ws)}/${id}`);
    expect(answer.status).toBe(status);
    if (status === 200)
      expect(await dataOf(answer)).toMatchObject({
        id,
        state,
        post_count: 0,
        derivatives: { thumb: "ready" },
      });
  });

  it.each([
    ["sets the tags", {}, { tags: ["spring", "launch"] }, 200, { tags: ["spring", "launch"] }],
    ["renames", {}, { file_name: "renamed.png" }, 200, { file_name: "renamed.png" }],
    [
      "keeps a rejected medium out of the library",
      { state: "rejected" },
      { in_library: true },
      409,
      "not_ready",
    ],
    ["never edits a deleted medium", { state: "deleted" }, { tags: ["late"] }, 404, undefined],
    ["refuses a tag longer than 64 characters", {}, { tags: ["t".repeat(65)] }, 400, undefined],
    [
      "refuses more than 32 tags",
      {},
      { tags: Array.from({ length: 33 }, (_, at) => `t${at}`) },
      400,
      undefined,
    ],
    ["refuses an empty change", {}, {}, 400, undefined],
  ])("PATCH %s", async (_what, shape, body, status, expected) => {
    const id = await plant(shape);
    const answer = await send(user("editor"), "PATCH", `${base(ws)}/${id}`, body);
    expect(answer.status).toBe(status);
    if (status === 200) expect(await dataOf(answer)).toMatchObject(expected as object);
    if (status === 409) expect(await reasonOf(answer)).toBe(expected);
  });
});

describe("a ready file in the workspace is answered as a duplicate, and deleting it frees its hash", () => {
  const register = (sha256: string) =>
    send(user("editor"), "POST", base(ws), {
      file_name: "again.png",
      mime: "image/png",
      byte_size: 8,
      sha256,
    });

  it("register answers the ready medium with no upload, and a new upload after its delete", async () => {
    const sha = "cd".repeat(32);
    const ready = await plant({}, sha);
    const again = await register(sha);
    expect([again.status, await dataOf(again)]).toEqual([201, { id: ready, duplicate: true }]);

    expect((await send(user("editor"), "DELETE", `${base(ws)}/${ready}`)).status).toBe(204);
    const fresh = await register(sha);
    expect(fresh.status).toBe(201);
    expect(await dataOf(fresh)).toMatchObject({ duplicate: false, url: expect.any(String) });
  });

  it.each([
    ["a medium the workspace avatar holds", {}, true, "in_use"],
    ["a medium still processing", { state: "processing" }, false, "not_deletable"],
  ])("DELETE refuses %s with its reason", async (_what, shape, avatar, reason) => {
    const id = await plant(shape);
    const setAvatar = (to: string | null) =>
      fx.admin((client) => client.query("UPDATE app.workspaces SET avatar = $2 WHERE id = $1", [ws, to]));
    if (avatar) await setAvatar(id);
    try {
      const answer = await send(user("editor"), "DELETE", `${base(ws)}/${id}`);
      expect([answer.status, await reasonOf(answer)]).toEqual([409, reason]);
    } finally {
      if (avatar) await setAvatar(null);
    }
  });
});
