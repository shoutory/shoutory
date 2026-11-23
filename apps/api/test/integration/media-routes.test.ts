import { createHash } from "node:crypto";
import { parseStorageEnv, type StorageConfig } from "@shoutory/core/config";
import { type StorageDriver, StorageError, type StorageErrorKind } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageDriver } from "../../src/storage/driver.js";
import { createS3Presigner } from "../../src/storage/s3-driver.js";
import { createBucket, s3Env } from "../support/s3.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// Security floor of the media upload routes (register, complete): who may start and finish an upload, the one 404 for
// what the caller may not see, a digest that storage proves and the client never supplies, and a complete that is
// idempotent and moves nothing when it is refused. The bytes go to the S3 simulator through the presigned URL, as a
// browser sends them.

type User = { id: string; cookie: string };
const BUCKET = "media-routes-1";
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
// The real driver, except that a test can make its `head` report no checksum, as a server that stores none would.
// It can also fail with a storage error of a chosen kind, as a driver whose server is down or refuses the keys would.
// And its `head` can be slow, so that two completes of one upload both read it pending before either finishes.
const hide: {
  checksum: boolean;
  size: number | null;
  throws: StorageErrorKind | null;
  delayMs: number;
} = { checksum: false, size: null, throws: null, delayMs: 0 };

beforeAll(async () => {
  await createBucket(BUCKET);
  const config = parseStorageEnv(s3Env(BUCKET)) as Extract<StorageConfig, { driver: "s3" }>;
  const real = createStorageDriver(config);
  const storage: StorageDriver = {
    ...real,
    get: async (key, range) => {
      if (hide.throws) throw new StorageError(hide.throws);
      return real.get(key, range);
    },
    head: async (key) => {
      if (hide.throws) throw new StorageError(hide.throws);
      const found = await real.head(key);
      if (hide.delayMs > 0) await new Promise((done) => setTimeout(done, hide.delayMs));
      if (!found) return found;
      const size = hide.size ?? found.size;
      return hide.checksum ? { size } : { ...found, size };
    },
  };
  fx = await startFixture({ storage, presigner: createS3Presigner(config) });
  const founder = await signedUser(fx, "media-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `media-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());

const hexOf = (text: string) => createHash("sha256").update(text).digest("hex");
const base = (workspace: string) => `/api/v1/workspaces/${workspace}/media`;
const call = (who: User, path: string, body?: unknown) =>
  fx.request(path, {
    method: "POST",
    headers: { cookie: who.cookie },
    ...(body === undefined ? {} : { body }),
  });
const registerBody = (text = "12345") => ({
  file_name: "photo.png",
  mime: "image/png",
  byte_size: Buffer.byteLength(text),
  sha256: hexOf(text),
});
const register = (who: User, workspace = ws, body: object = registerBody()) =>
  call(who, base(workspace), body);
const complete = (who: User, id: string, workspace = ws) => call(who, `${base(workspace)}/${id}/complete`);
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;
const errorOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error;

interface Started {
  id: string;
  url: string;
  headers: Record<string, string>;
}
async function started(who = user("editor"), text = "12345", workspace = ws): Promise<Started> {
  const answer = await register(who, workspace, registerBody(text));
  expect(answer.status).toBeLessThan(300);
  return (await dataOf(answer)) as unknown as Started;
}
/** What a browser does with the answer of register: one PUT to the URL with exactly the headers it was given. */
async function upload(info: Started, text: string) {
  const answer = await fetch(info.url, { method: "PUT", body: text, headers: info.headers });
  return { status: answer.status, code: /<Code>([^<]*)<\/Code>/.exec(await answer.text())?.[1] };
}
const assetOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT a.state, encode(a.sha256, 'hex') AS sha256, u.completed_at
           FROM app.media_assets a LEFT JOIN app.media_uploads u ON u.workspace_id = a.workspace_id AND u.media_id = a.id
           WHERE a.id = $1`,
          [id],
        )
      ).rows[0] as { state: string; sha256: string | null; completed_at: Date | null },
  );
const assetCount = (workspace: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query("SELECT count(*)::int AS n FROM app.media_assets WHERE workspace_id = $1", [
          workspace,
        ])
      ).rows[0].n as number,
  );

describe("who may register and complete an upload", () => {
  it.each(["viewer", "approver"])(
    "a %s cannot register or complete, and nothing is created or moved",
    async (seat) => {
      const real = await started();
      const before = await assetCount(ws);
      expect((await register(user(seat))).status).toBe(403);
      const refused = await complete(user(seat), real.id);
      expect(refused.status).toBe(403);
      expect(await assetCount(ws)).toBe(before);
      expect((await assetOf(real.id)).state).toBe("pending_upload");
    },
  );
});

const getOriginal = (who: User, id: string, workspace = ws) =>
  fx.request(`${base(workspace)}/${id}/original`, { method: "GET", headers: { cookie: who.cookie } });

describe("a failing store answers by what failed, and names nothing of the store", () => {
  it.each([
    ["failed", 503, "service_unavailable"],
    ["denied", 503, "service_unavailable"],
    ["unsupported", 503, "service_unavailable"],
    ["exists", 409, "conflict"],
    ["too_large", 409, "conflict"],
    ["invalid_key", 500, "internal_error"],
  ] as const)(
    "a driver that fails with %s answers complete and read with %s %s",
    async (kind, status, code) => {
      const text = `store-${kind}-1`;
      const live = await started(user("editor"), text);
      expect((await upload(live, text)).status).toBe(200);
      expect((await complete(user("editor"), live.id)).status).toBe(200);
      const pending = await started(user("editor"), `pending-${kind}-1`);
      hide.throws = kind;
      try {
        for (const answer of [
          await complete(user("editor"), pending.id),
          await getOriginal(user("viewer"), live.id),
        ]) {
          expect(answer.status).toBe(status);
          const raw = await answer.text();
          expect((JSON.parse(raw) as { error: { code: string } }).error.code).toBe(code);
          expect(raw).not.toContain(kind);
        }
      } finally {
        hide.throws = null;
      }
      expect((await assetOf(pending.id)).state).toBe("pending_upload");
    },
  );
});

describe("what a caller may not see looks like an unknown asset", () => {
  it("answers 404 not_found alike for a stranger, another workspace's asset and an unknown id, and moves nothing", async () => {
    const mine = await started();
    const theirs = await started(user("foreign"), "foreign-owned-1", other);
    const unknown = "00000000-0000-4000-8000-000000000001";
    const cases: [string, () => Promise<Response>][] = [
      ["an unknown id, complete", () => complete(user("editor"), unknown)],
      ["an unknown id, read", () => getOriginal(user("editor"), unknown)],
      ["a non-member registering", () => register(user("outsider"))],
      ["a non-member completing", () => complete(user("outsider"), mine.id)],
      ["a member of another workspace completing", () => complete(user("foreign"), mine.id)],
      ["that member through its own workspace's path", () => complete(user("foreign"), mine.id, other)],
      ["B's asset through A's path, complete", () => complete(user("editor"), theirs.id)],
      ["B's asset through A's path, read", () => getOriginal(user("editor"), theirs.id)],
    ];
    for (const [label, run] of cases) {
      const answer = await run();
      expect(answer.status, label).toBe(404);
      expect((await errorOf(answer)).code, label).toBe("not_found");
    }
    expect([(await assetOf(mine.id)).state, (await assetOf(theirs.id)).state]).toEqual([
      "pending_upload",
      "pending_upload",
    ]);
  });
});

describe("the same bytes are one asset in a workspace", () => {
  it("the same sha256 uploaded twice in one workspace reuses the first asset; in two workspaces it stays two assets", async () => {
    const first = await started(user("editor"), "dedupe-bytes-1");
    expect((await upload(first, "dedupe-bytes-1")).status).toBe(200);
    expect(await dataOf(await complete(user("editor"), first.id))).toMatchObject({ id: first.id });

    const again = await started(user("admin"), "dedupe-bytes-1");
    expect((await upload(again, "dedupe-bytes-1")).status).toBe(200);
    expect(await dataOf(await complete(user("admin"), again.id))).toMatchObject({ id: first.id });
    expect((await assetOf(again.id)).state).toBe("deleted");
    expect((await assetOf(first.id)).state).toBe("uploaded");
    // A replay of the second complete answers the live id too.
    expect(await dataOf(await complete(user("admin"), again.id))).toMatchObject({ id: first.id });

    const theirs = await started(user("foreign"), "dedupe-bytes-1", other);
    expect((await upload(theirs, "dedupe-bytes-1")).status).toBe(200);
    const done = await dataOf(await complete(user("foreign"), theirs.id, other));
    expect(done).toMatchObject({ id: theirs.id });
    expect(theirs.id).not.toBe(first.id);
    expect((await assetOf(theirs.id)).state).toBe("uploaded");
  });
});

describe("the size bound and the pending cap", () => {
  const MAX = 64 * 1024 * 1024;
  it.each([
    ["one byte over 64 MiB", MAX + 1, 400],
    ["zero", 0, 400],
    ["a fraction", 1.5, 400],
    ["exactly 64 MiB", MAX, 201],
  ])("register of a declared size of %s answers %s", async (_name, byteSize, status) => {
    const before = await assetCount(ws);
    const answer = await register(user("editor"), ws, { ...registerBody(), byte_size: byteSize });
    expect(answer.status).toBe(status);
    if (status === 400) expect((await errorOf(answer)).code).toBe("validation_failed");
    expect(await assetCount(ws)).toBe(status === 400 ? before : before + 1);
  });

  it("complete refuses a stored size above 64 MiB and moves nothing", async () => {
    const info = await started(user("editor"), "stored-size-1");
    expect((await upload(info, "stored-size-1")).status).toBe(200);
    hide.size = MAX + 1;
    try {
      expect((await complete(user("editor"), info.id)).status).toBe(409);
      expect(await assetOf(info.id)).toMatchObject({ state: "pending_upload", sha256: null });
    } finally {
      hide.size = null;
    }
  });

  it("the 101st pending upload of a workspace answers limit_reached", async () => {
    const crowded = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
    await addWorkspaceMember(fx, crowded, user("editor").id, "editor");
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.media_assets (workspace_id, object_key, file_name, source, created_by)
         SELECT $1::uuid, 'ws/' || $1::text || '/' || gen_random_uuid()::text || '/1/original', 'x.png', 'upload', $2::uuid
         FROM generate_series(1, 100)`,
        [crowded, user("editor").id],
      ),
    );
    const answer = await register(user("editor"), crowded);
    expect(answer.status).toBe(409);
    expect((await errorOf(answer)).code).toBe("limit_reached");
    expect(await assetCount(crowded)).toBe(100);
  });
});

describe("the digest is proved by storage, never supplied by the client", () => {
  it("a head that reports no sha256 makes complete answer 409 and never falls back to the client's hash", async () => {
    const info = await started(user("editor"), "no-checksum-1");
    expect((await upload(info, "no-checksum-1")).status).toBe(200);
    hide.checksum = true;
    try {
      const answer = await complete(user("editor"), info.id);
      expect(answer.status).toBe(409);
      expect(await assetOf(info.id)).toMatchObject({
        state: "pending_upload",
        sha256: null,
        completed_at: null,
      });
    } finally {
      hide.checksum = false;
    }
    expect((await complete(user("editor"), info.id)).status).toBe(200);
    expect((await assetOf(info.id)).sha256).toBe(hexOf("no-checksum-1"));
  });
});

describe("complete is idempotent and moves nothing when it is refused", () => {
  it("two completes at once both answer the live id", async () => {
    const info = await started(user("editor"), "concurrent-1");
    expect((await upload(info, "concurrent-1")).status).toBe(200);
    hide.delayMs = 300;
    const answers = await Promise.all([
      complete(user("editor"), info.id),
      complete(user("admin"), info.id),
    ]).finally(() => {
      hide.delayMs = 0;
    });
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await Promise.all(answers.map(dataOf))).toEqual([{ id: info.id }, { id: info.id }]);
  });

  it("answers 409 with no object, and the same live id on a second complete after success", async () => {
    const info = await started(user("editor"), "idempotent-1");
    const early = await complete(user("editor"), info.id);
    expect(early.status).toBe(409);
    expect(await assetOf(info.id)).toMatchObject({
      state: "pending_upload",
      sha256: null,
      completed_at: null,
    });

    expect((await upload(info, "idempotent-1")).status).toBe(200);
    const first = await complete(user("editor"), info.id);
    expect(first.status).toBe(200);
    expect(await dataOf(first)).toMatchObject({ id: info.id });
    const second = await complete(user("editor"), info.id);
    expect(second.status).toBe(200);
    expect(await dataOf(second)).toMatchObject({ id: info.id });
    expect(await assetOf(info.id)).toMatchObject({ state: "uploaded", sha256: hexOf("idempotent-1") });
  });
});
