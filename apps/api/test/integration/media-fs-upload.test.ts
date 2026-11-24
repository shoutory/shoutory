import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StorageDriver, StorageError, type StorageErrorKind } from "@shoutory/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture, WEB } from "./auth/harness.js";

type User = { id: string; cookie: string };
const MAX = 64 * 1024 * 1024;
const SEATS = ["owner", "editor", "viewer", "approver"] as const;
let fx: Fixture;
let ws: string;
let other: string;
let dir: string;
let real: StorageDriver;
const users: Record<string, User> = {};
const user = (name: string): User => users[name] as User;
// A `put` can fail with a chosen storage error, with the bytes stored first when the server lost only its answer.
const fail: { kind: StorageErrorKind | null; stored: boolean } = { kind: null, stored: false };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-fs-upload-"));
  real = createFsDriver(dir);
  const storage: StorageDriver = {
    ...real,
    put: async (key, body, maxBytes, options) => {
      if (!fail.kind) return real.put(key, body, maxBytes, options);
      if (fail.stored) await real.put(key, body, maxBytes, options);
      throw new StorageError(fail.kind);
    },
  };
  fx = await startFixture({ storage });
  const founder = await signedUser(fx, "fsup-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `fsup-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

const hexOf = (text: string) => createHash("sha256").update(text).digest("hex");
const keyOf = (workspace: string, id: string) => `ws/${workspace}/${id}/1/original`;
const stream = (text: string) => new Blob([text]).stream();
const readText = async (body: ReadableStream<Uint8Array> | null) =>
  body === null ? null : new TextDecoder().decode(await new Response(body).arrayBuffer());

async function plant(workspace = ws, state = "pending_upload", minutesOld = 0): Promise<string> {
  const id = randomUUID();
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256, byte_size, created_at)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'f.png', 'image/png', 'upload',
         $3::uuid, $4::text, CASE WHEN $4::text = 'pending_upload' THEN NULL ELSE decode($5, 'hex') END,
         CASE WHEN $4::text = 'pending_upload' THEN NULL ELSE 8 END,
         clock_timestamp() - make_interval(mins => $6::int))`,
      [id, workspace, user("owner").id, state, hexOf(id), minutesOld],
    ),
  );
  return id;
}

interface Sent {
  who?: User | null;
  workspace?: string;
  body?: string;
  stream?: ReadableStream<Uint8Array>;
  headers?: Record<string, string | null>;
  csrf?: boolean;
}
function put(id: string, sent: Sent = {}) {
  const who = sent.who === undefined ? user("editor") : sent.who;
  const body = sent.body ?? "12345";
  const headers: Record<string, string> = {
    ...(sent.csrf === false ? {} : WEB),
    "content-type": "application/octet-stream",
    ...(who ? { cookie: who.cookie } : {}),
    "content-length": String(Buffer.byteLength(body)),
  };
  for (const [name, value] of Object.entries(sent.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  return fx.app.request(
    `/api/v1/workspaces/${sent.workspace ?? ws}/media/${id}/original`,
    {
      method: "PUT",
      headers,
      ...(sent.stream ? { body: sent.stream, duplex: "half" } : body === "" ? {} : { body }),
    },
    { incoming: { socket: { remoteAddress: "192.0.2.77" } } },
  );
}
const codeOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error.code;
const stateOf = (id: string) =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT state FROM app.media_assets WHERE id = $1", [id])).rows[0].state as string,
  );

describe("a raw body route", () => {
  it("skips the JSON check but keeps CSRF, the session and library.edit", async () => {
    const id = await plant();
    const foreignAsset = await plant(other);
    const refused: [string, Promise<Response> | Response, number][] = [
      ["a Viewer", put(id, { who: user("viewer") }), 403],
      ["an Approver", put(id, { who: user("approver") }), 403],
      ["a non-member", put(id, { who: user("outsider") }), 404],
      ["no CSRF headers", put(id, { csrf: false }), 403],
      ["no session", put(id, { who: null }), 401],
      ["another workspace's asset", put(foreignAsset), 404],
    ];
    for (const [label, answer, status] of refused) expect((await answer).status, label).toBe(status);
    expect(await real.head(keyOf(ws, id))).toBeNull();
    expect(await real.head(keyOf(ws, foreignAsset))).toBeNull();
    expect(await stateOf(id)).toBe("pending_upload");
  });
});

// [what is wrong, how the request is shaped, the status, the error code]
const REFUSALS: [string, Sent & { minutesOld?: number }, number, string][] = [
  [
    "a declared length over 64 MiB",
    { headers: { "content-length": String(MAX + 1) } },
    413,
    "payload_too_large",
  ],
  [
    "a body longer than its declared length",
    { body: "123456789", headers: { "content-length": "5" } },
    413,
    "payload_too_large",
  ],
  ["no content-length", { headers: { "content-length": null } }, 400, "validation_failed"],
  [
    "a transfer-encoding",
    { headers: { "content-length": null, "transfer-encoding": "chunked" } },
    400,
    "validation_failed",
  ],
  [
    "a content-length that is not a number",
    { headers: { "content-length": "12abc" } },
    400,
    "validation_failed",
  ],
  ["a content-length of zero", { body: "", headers: { "content-length": "0" } }, 400, "validation_failed"],
  ["another content type", { headers: { "content-type": "image/png" } }, 400, "validation_failed"],
  ["an upload registered 16 minutes ago", { minutesOld: 16 }, 409, "conflict"],
];

describe("the PUT refuses", () => {
  it.each(REFUSALS)("%s, and stores nothing", async (_name, sent, status, code) => {
    const id = await plant(ws, "pending_upload", sent.minutesOld ?? 0);
    const answer = await put(id, sent);
    expect(answer.status).toBe(status);
    expect(await codeOf(answer)).toBe(code);
    expect(await real.head(keyOf(ws, id))).toBeNull();
    expect(await stateOf(id)).toBe("pending_upload");
  });

  it("accepts an upload registered 14 minutes ago", async () => {
    expect((await put(await plant(ws, "pending_upload", 14))).status).toBe(200);
  });

  it("cancels the body of a refused PUT, so a client trickling it cannot hold the connection", async () => {
    const id = await plant(ws, "uploaded");
    let cancelled = false;
    const trickle = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
      },
    });
    const answer = await put(id, { stream: trickle, headers: { "content-length": String(MAX) } });
    expect(answer.status).toBe(409);
    await new Promise((done) => setTimeout(done, 50));
    expect(cancelled).toBe(true);
  });

  it("a finished original answers 409 and its stored bytes stay as they were", async () => {
    const id = await plant(ws, "uploaded");
    await real.put(keyOf(ws, id), stream("original!"), 1024);
    const answer = await put(id, { body: "replaced!" });
    expect(answer.status).toBe(409);
    expect(await codeOf(answer)).toBe("conflict");
    expect(await readText(await real.get(keyOf(ws, id)))).toBe("original!");
    expect(await stateOf(id)).toBe("uploaded");
  });
});

describe("two PUTs of different bytes to one pending upload", () => {
  it("store exactly one body; the other answers 409 and the stored bytes are the winner's", async () => {
    const id = await plant();
    const bodies = ["first-body", "second-body"];
    const answers = await Promise.all(bodies.map((body) => put(id, { body })));
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([200, 409]);
    const winner = bodies[answers.findIndex((answer) => answer.status === 200)];
    expect(await readText(await real.get(keyOf(ws, id)))).toBe(winner);
  });
});

describe("a put that fails or finds the object", () => {
  // [what happened to the put, what storage holds, the bytes sent, the status]
  const SETTLES: [string, StorageErrorKind | null, string | null, string, number][] = [
    ["finds the same bytes already stored (a crash after the put)", null, "12345", "12345", 200],
    ["finds other bytes already stored", null, "other", "12345", 409],
    ["loses its answer after storing the same bytes", "failed", null, "12345", 200],
    ["fails with nothing stored", "failed", "none", "12345", 503],
  ];
  it.each(SETTLES)("%s: settles by head and sha256", async (_name, kind, stored, sent, status) => {
    const id = await plant();
    if (stored !== null && stored !== "none" && kind === null)
      await real.put(keyOf(ws, id), stream(stored), 1024);
    fail.kind = kind;
    fail.stored = kind !== null && stored === null;
    try {
      expect((await put(id, { body: sent })).status).toBe(status);
    } finally {
      fail.kind = null;
      fail.stored = false;
    }
    const kept = await readText(await real.get(keyOf(ws, id)));
    expect(kept).toBe(status === 503 ? null : stored === null || kind !== null ? sent : stored);
  });
});

const asUser = (who: User, path: string, body?: unknown) =>
  fx.request(path, {
    method: "POST",
    headers: { cookie: who.cookie },
    ...(body === undefined ? {} : { body }),
  });
const registerFs = (text: string, workspace = ws, who = user("editor")) =>
  asUser(who, `/api/v1/workspaces/${workspace}/media`, {
    file_name: "photo.png",
    mime: "image/png",
    byte_size: Buffer.byteLength(text),
    sha256: hexOf(text),
  });
const completeFs = (id: string, workspace = ws, who = user("editor")) =>
  asUser(who, `/api/v1/workspaces/${workspace}/media/${id}/complete`);
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;

describe("register, PUT and complete on the filesystem driver", () => {
  it("records the size and sha256 of the stored bytes, never the declared ones, and complete is safe to repeat", async () => {
    const answer = await registerFs("claimed-bytes");
    expect(answer.status).toBe(201);
    const { id, url, headers } = (await dataOf(answer)) as {
      id: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(url).toBe(`/api/v1/workspaces/${ws}/media/${id}/original`);
    expect(headers).toEqual({ "content-type": "application/octet-stream" });
    expect((await put(id, { body: "actual-bytes" })).status).toBe(200);
    const done = await completeFs(id);
    expect(done.status).toBe(200);
    expect(await dataOf(done)).toEqual({ id });
    expect(await dataOf(await completeFs(id))).toEqual({ id });
    const row = await fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT state, byte_size::int AS size, encode(sha256, 'hex') AS sha256 FROM app.media_assets WHERE id = $1",
            [id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ state: "uploaded", size: 12, sha256: hexOf("actual-bytes") });
  });

  it("complete answers 409 for an empty file and moves nothing", async () => {
    const empty = await plant();
    await real.put(keyOf(ws, empty), stream(""), 1024);
    expect((await completeFs(empty)).status).toBe(409);
    expect(await stateOf(empty)).toBe("pending_upload");
  });
});
