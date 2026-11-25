import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { processAsset } from "../../src/jobs/media/pipeline.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture, WEB } from "./auth/harness.js";

type User = { id: string; cookie: string };
type Signed = { number: number; url: string; headers: Record<string, string> };
const MIB = 1024 * 1024;
const PART = 16 * MIB;
const LARGE = 64 * MIB + 1;
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
let fx: Fixture;
let ws: string;
let other: string;
let dir: string;
let real: ReturnType<typeof createFsDriver>;
let freeBytes: number | null | undefined;
const users: Record<string, User> = {};
const user = (name: string): User => users[name] as User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-fs-parts-"));
  const driver = createFsDriver(dir);
  // The free space the disk reports, unless a row sets it: a row of the full-disk refusal.
  real = { ...driver, check: async () => (freeBytes === undefined ? driver.check() : { freeBytes }) };
  fx = await startFixture({ storage: real });
  const founder = await signedUser(fx, "fsparts-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `fsparts-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const base = (workspace: string) => `/api/v1/workspaces/${workspace}/media`;
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;
const post = (who: User, path: string, body?: unknown) =>
  fx.request(path, {
    method: "POST",
    headers: { cookie: who.cookie },
    ...(body === undefined ? {} : { body }),
  });
/** A body of 64 MiB + 1 bytes that no other upload of this file shares (a second upload of a digest is a duplicate). */
const bodyOf = (seed: string) => Buffer.alloc(LARGE, `fs-parts-${seed}-`);
const partOf = (body: Buffer, number: number) => body.subarray((number - 1) * PART, number * PART);
const NUMBERS = [1, 2, 3, 4, 5];

interface Registered {
  who?: User;
  workspace?: string;
  size?: number;
  body?: Buffer;
}
const register = ({ who = user("editor"), workspace = ws, size = LARGE, body }: Registered = {}) =>
  post(who, base(workspace), {
    file_name: "big.bin",
    mime: "application/octet-stream",
    byte_size: size,
    sha256: sha(body ?? randomUUID()),
  });
async function startBig(registered: Registered = {}): Promise<string> {
  const answer = await register(registered);
  expect(answer.status).toBe(201);
  const data = await dataOf(answer);
  expect(data.part_size).toBe(PART);
  expect(data).not.toHaveProperty("url");
  return data.id as string;
}
const sign = (who: User, id: string, numbers: number[], workspace = ws) =>
  post(who, `${base(workspace)}/${id}/parts`, {
    parts: numbers.map((number) => ({ number, sha256: sha("part") })),
  });

interface Put {
  who?: User | null;
  workspace?: string;
  csrf?: boolean;
  length?: string;
}
function putPart(id: string, number: string | number, body: Buffer, sent: Put = {}) {
  const who = sent.who === undefined ? user("editor") : sent.who;
  return fx.app.request(
    `${base(sent.workspace ?? ws)}/${id}/parts/${number}`,
    {
      method: "PUT",
      headers: {
        ...(sent.csrf === false ? {} : WEB),
        "content-type": "application/octet-stream",
        ...(who ? { cookie: who.cookie } : {}),
        "content-length": sent.length ?? String(body.length),
      },
      body,
    },
    { incoming: { socket: { remoteAddress: "192.0.2.77" } } },
  );
}
async function uploadParts(id: string, body: Buffer, numbers = NUMBERS, tampered?: number): Promise<void> {
  const signed = (await dataOf(await sign(user("editor"), id, numbers))).parts as Signed[];
  for (const { number, url, headers } of signed) {
    expect(url).toBe(`${base(ws)}/${id}/parts/${number}`);
    const bytes =
      number === tampered ? Buffer.alloc(partOf(body, number).length, "tampered-") : partOf(body, number);
    const stored = await fx.app.request(
      url,
      {
        method: "PUT",
        headers: {
          ...WEB,
          ...headers,
          cookie: user("editor").cookie,
          "content-length": String(bytes.length),
        },
        body: bytes,
      },
      { incoming: { socket: { remoteAddress: "192.0.2.77" } } },
    );
    expect(stored.status).toBe(200);
  }
}
const complete = (id: string) => post(user("editor"), `${base(ws)}/${id}/complete`);
const partKey = (workspace: string, id: string, number: number | string) =>
  `ws/${workspace}/${id}/parts/${number}`;
const originalKey = (id: string) => `ws/${ws}/${id}/1/original`;
const tree = async () => (await readdir(dir, { recursive: true })).sort();
const assetOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          "SELECT state, encode(sha256, 'hex') AS sha256, byte_size::float8 AS byte_size FROM app.media_assets WHERE id = $1",
          [id],
        )
      ).rows[0] as { state: string; sha256: string | null; byte_size: number | null },
  );

// Only a video may be this large. The child that would run ffprobe prints the answer recorded from the real binary.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const fixture = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url));
async function probePrintsRecordedMp4(): Promise<void> {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const text = fixture("ffprobe/h264.mp4.json").toString("utf8");
  vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
    real.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`], options as never),
  );
}

describe("a file above 64 MiB goes to the filesystem in parts", () => {
  it("registers, takes its parts, completes and is ready after the pipeline, with its part files gone", async () => {
    const video = fixture("h264.mp4");
    const body = Buffer.concat([video, Buffer.alloc(LARGE - video.length)]);
    const answer = await post(user("editor"), base(ws), {
      file_name: "big.mp4",
      mime: "video/mp4",
      byte_size: LARGE,
      sha256: sha(body),
    });
    expect(answer.status).toBe(201);
    const { id, part_size: partSize } = (await dataOf(answer)) as { id: string; part_size: number };
    expect(partSize).toBe(PART);
    await uploadParts(id, body);
    const done = await complete(id);
    expect([done.status, await dataOf(done)]).toEqual([200, { id }]);
    expect(await assetOf(id)).toMatchObject({ state: "uploaded", sha256: sha(body), byte_size: LARGE });
    expect(await real.head(originalKey(id))).toMatchObject({ size: LARGE, sha256: sha(body) });
    // The part files and their folder are gone once the original is stored.
    expect(await readdir(join(dir, "ws", ws, id))).toEqual(["1"]);
    for (const number of NUMBERS) expect(await real.head(partKey(ws, id, number))).toBeNull();
    await probePrintsRecordedMp4();
    const deps = {
      pool: fx.db.pool("worker"),
      storage: real,
      scratchDir: tmpdir(),
      ffprobe: process.execPath,
    };
    await processAsset(deps, ws, id);
    expect((await assetOf(id)).state).toBe("ready");
  }, 180_000);

  it("answers a part number beyond the declared five when it is signed, as on S3 (422)", async () => {
    expect((await sign(user("editor"), await startBig(), [6])).status).toBe(422);
  });
});

describe("who may put a part, and into which upload (floor)", () => {
  it("a part of another workspace's asset, put by an editor through its own workspace, answers 404 and writes nothing", async () => {
    const theirs = await startBig({ who: user("foreign"), workspace: other });
    const before = await tree();
    const answer = await putPart(theirs, 1, Buffer.alloc(1, "x"));
    expect(answer.status).toBe(404);
    expect(await tree()).toEqual(before);
    expect(await real.head(partKey(other, theirs, 1))).toBeNull();
  });

  it("a viewer, an approver, a stranger, a request without the web-client headers and one without a session are refused, and nothing is stored", async () => {
    const id = await startBig();
    const body = Buffer.alloc(1, "x");
    const refused: [string, Promise<Response> | Response, number][] = [
      ["a viewer", putPart(id, 1, body, { who: user("viewer") }), 403],
      ["an approver", putPart(id, 1, body, { who: user("approver") }), 403],
      ["a non-member", putPart(id, 1, body, { who: user("outsider") }), 404],
      ["no CSRF headers", putPart(id, 1, body, { csrf: false }), 403],
      ["no session", putPart(id, 1, body, { who: null }), 401],
    ];
    for (const [label, answer, status] of refused) expect((await answer).status, label).toBe(status);
    expect(await real.head(partKey(ws, id, 1))).toBeNull();
  });

  // [what the number is, the statuses a server may answer]: a number never reaches a key unless it is a plain number.
  it.each([
    ["0", [400]],
    ["001", [400]],
    ["1.5", [400]],
    ["../1", [400, 404]],
    ["%2e%2e", [400, 404]],
    ["999", [422]],
    ["6", [422]],
  ])(
    "part number %s is refused and nothing is written outside the parts folder",
    async (number, statuses) => {
      const id = await startBig();
      const before = await tree();
      const answer = await putPart(id, number, Buffer.alloc(1, "x"));
      expect(statuses).toContain(answer.status);
      expect(await tree()).toEqual(before);
    },
  );
});

describe("how long a part may be (floor)", () => {
  // [what is sent, the part, the length the header declares, the status]
  it.each([
    ["1 KiB for a whole part", 1, 1024, undefined, 422],
    ["2 bytes for the last part, which is 1 byte", 5, 2, undefined, 422],
    ["a declared length over a part", 1, 1, String(PART + 1), 413],
    ["a body that ends short of its declared part length", 1, 1024, String(PART), 422],
  ])("%s is refused and nothing is stored", async (_name, number, size, length, status) => {
    const id = await startBig();
    const answer = await putPart(id, number, Buffer.alloc(size, "x"), length ? { length } : {});
    expect(answer.status).toBe(status);
    expect(await real.head(partKey(ws, id, number))).toBeNull();
  });
});

describe("complete assembles the parts only into the declared file (floor)", () => {
  it("a part put after complete answers 409 and the finished original's bytes are unchanged", async () => {
    const body = bodyOf("after");
    const id = await startBig({ body });
    await uploadParts(id, body);
    expect((await complete(id)).status).toBe(200);
    const before = await real.head(originalKey(id));
    expect((await putPart(id, 1, Buffer.alloc(1, "later"))).status).toBe(409);
    expect(await real.head(originalKey(id))).toEqual(before);
    expect(await real.head(partKey(ws, id, 1))).toBeNull();
  }, 180_000);

  it("a complete with bytes that are not the declared digest answers 409 and stores no original, and a retry with the right part succeeds", async () => {
    const body = bodyOf("digest");
    const id = await startBig({ body });
    await uploadParts(id, body, NUMBERS, 3);
    expect((await complete(id)).status).toBe(409);
    expect(await real.head(originalKey(id))).toBeNull();
    // The refused assembly leaves no temporary file behind, and the parts stay for the retry.
    expect((await tree()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await real.head(partKey(ws, id, 3))).not.toBeNull();
    // A retry puts the right bytes of the part again (a part replaces its own earlier bytes) and completes.
    await uploadParts(id, body, [3]);
    expect((await complete(id)).status).toBe(200);
    expect(await assetOf(id)).toMatchObject({ state: "uploaded", sha256: sha(body) });
  }, 180_000);

  it("a complete whose original already exists (a lost answer) settles by what storage holds", async () => {
    const body = bodyOf("lost");
    const id = await startBig({ body });
    await uploadParts(id, body);
    await real.put(originalKey(id), new Blob([new Uint8Array(body)]).stream(), LARGE, { ifAbsent: true });
    const done = await complete(id);
    expect([done.status, await dataOf(done)]).toEqual([200, { id }]);
    expect(await assetOf(id)).toMatchObject({ state: "uploaded", sha256: sha(body) });
  }, 180_000);

  it("a part that is missing when complete assembles answers 409 and stores no original", async () => {
    const body = bodyOf("missing");
    const id = await startBig({ body });
    await uploadParts(id, body, [1, 5]);
    expect((await complete(id)).status).toBe(409);
    expect(await real.head(originalKey(id))).toBeNull();
    expect((await assetOf(id)).state).toBe("pending_upload");
  }, 180_000);
});

describe("complete on a full disk (floor)", () => {
  it("a complete on a disk with less free space than the declared file answers 503, keeps the parts, and succeeds once there is room", async () => {
    const body = bodyOf("space");
    const id = await startBig({ body });
    await uploadParts(id, body);
    freeBytes = LARGE - 1;
    try {
      const refused = await complete(id);
      expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([
        503,
        "service_unavailable",
      ]);
      expect(await real.head(originalKey(id))).toBeNull();
      for (const number of NUMBERS) expect(await real.head(partKey(ws, id, number))).not.toBeNull();
      expect((await assetOf(id)).state).toBe("pending_upload");
    } finally {
      freeBytes = undefined;
    }
    expect((await complete(id)).status).toBe(200);
  }, 180_000);
});
