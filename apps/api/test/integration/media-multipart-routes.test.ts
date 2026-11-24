import { createHash, randomUUID } from "node:crypto";
import { parseStorageEnv, type StorageConfig } from "@shoutory/core/config";
import { type StorageDriver, StorageError, type StorageErrorKind } from "@shoutory/core/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStorageDriver } from "../../src/storage/driver.js";
import { createS3Multipart, createS3Presigner, type S3Multipart } from "../../src/storage/s3-driver.js";
import { createBucket, s3Env } from "../support/s3.js";
import { addWorkspaceMember, seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// The storage calls of the server go through a wrapper that can answer what a real bucket would answer only after
// gigabytes (a crafted list of parts, a missing upload), so most rows move no large body.

type User = { id: string; cookie: string };
type Signed = { number: number; url: string; headers: Record<string, string> };
const BUCKET = "media-multipart-1";
const MIB = 1024 * 1024;
const PART = 16 * MIB;
const CAP = 5 * 1024 * MIB;
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
let fx: Fixture;
let ws: string;
let other: string;
let real: StorageDriver;
const users: Record<string, User> = {};
const user = (name: string): User => users[name] as User;

interface Part {
  number: number;
  size: number;
  etag: string;
}
// What the wrapper answers instead of the real bucket: `undefined` is the real answer.
const faked: {
  parts?: Part[] | null;
  head?: number | null;
  complete?: "skip" | StorageErrorKind;
  race?: (key: string) => Promise<void>;
  create?: StorageErrorKind;
} = {};
const calls: string[] = [];
const idleInTransaction: number[] = [];
const puts: string[] = [];
const completed: unknown[][] = [];
let sent = 0;

/** The database sessions in an open transaction right now: nonzero while a storage call runs means it is inside one. */
const idleCount = () =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`,
        )
      ).rows[0].n as number,
  );
async function seen(name: string): Promise<void> {
  calls.push(name);
  idleInTransaction.push(await idleCount());
}

beforeAll(async () => {
  await createBucket(BUCKET);
  const config = parseStorageEnv(s3Env(BUCKET)) as Extract<StorageConfig, { driver: "s3" }>;
  real = createStorageDriver(config);
  const storage: StorageDriver = {
    ...real,
    put: async (key, body, max, options) => {
      puts.push(key);
      return real.put(key, body, max, options);
    },
    head: async (key) => {
      await seen("head");
      if (faked.head === undefined) return real.head(key);
      return faked.head === null ? null : { size: faked.head };
    },
  };
  const server = createS3Multipart(config);
  const multipart: S3Multipart = {
    ...server,
    createUpload: async (key) => {
      await seen("create");
      await faked.race?.(key);
      if (faked.create) throw new StorageError(faked.create);
      return server.createUpload(key);
    },
    listParts: async (key, uploadId) => {
      await seen("list");
      return faked.parts === undefined ? server.listParts(key, uploadId) : faked.parts;
    },
    complete: async (key, uploadId, parts, size) => {
      await seen("complete");
      completed.push([key, uploadId, parts, size]);
      if (faked.complete === "skip") return;
      if (faked.complete) throw new StorageError(faked.complete);
      return server.complete(key, uploadId, parts, size);
    },
    abort: async (key, uploadId) => {
      calls.push("abort");
      return server.abort(key, uploadId);
    },
  };
  fx = await startFixture({ storage, presigner: createS3Presigner(config), multipart });
  const founder = await signedUser(fx, "multipart-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"])
    users[name] = await signedUser(fx, `multipart-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(() => fx.close());
beforeEach(() => {
  for (const key of Object.keys(faked)) delete (faked as Record<string, unknown>)[key];
  for (const list of [calls, idleInTransaction, puts, completed]) list.length = 0;
  sent = 0;
});

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const base = (workspace: string) => `/api/v1/workspaces/${workspace}/media`;
const call = (who: User, path: string, body?: unknown) => {
  if (body !== undefined) sent += JSON.stringify(body).length;
  return fx.request(path, {
    method: "POST",
    headers: { cookie: who.cookie },
    ...(body === undefined ? {} : { body }),
  });
};
const dataOf = async (answer: Response) => ((await answer.json()) as { data: Record<string, unknown> }).data;
const errorOf = async (answer: Response) => ((await answer.json()) as { error: { code: string } }).error;
interface Big {
  who?: User;
  workspace?: string;
  size?: number;
  digest?: string;
}
// Every upload declares a digest of its own: a second upload of the same bytes would be answered as a duplicate.
const registerBig = ({ who = user("editor"), workspace = ws, size = 70 * MIB, digest }: Big = {}) =>
  call(who, base(workspace), {
    file_name: "big.bin",
    mime: "application/octet-stream",
    byte_size: size,
    sha256: digest ?? sha(randomUUID()),
  });
async function startBig(big: Big = {}): Promise<string> {
  const answer = await registerBig(big);
  expect(answer.status).toBe(201);
  const data = await dataOf(answer);
  expect(data.part_size).toBe(PART);
  return data.id as string;
}
const sign = (who: User, id: string, parts: { number: number; sha256: string }[], workspace = ws) =>
  call(who, `${base(workspace)}/${id}/parts`, { parts });
const complete = (who: User, id: string, workspace = ws) => call(who, `${base(workspace)}/${id}/complete`);
async function signedPart(id: string, number: number, body: Buffer, who = user("editor")): Promise<Signed> {
  const answer = await sign(who, id, [{ number, sha256: sha(body) }]);
  return ((await dataOf(answer)).parts as Signed[])[0] as Signed;
}
const putTo = (part: Signed, body: Buffer, url: string | URL = part.url) =>
  fetch(url, { method: "PUT", body, headers: part.headers });
const assetOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT a.state, encode(a.sha256, 'hex') AS sha256, a.byte_size::float8 AS byte_size,
             u.multipart_upload_id, encode(u.declared_sha256, 'hex') AS declared
           FROM app.media_assets a LEFT JOIN app.media_uploads u ON u.workspace_id = a.workspace_id AND u.media_id = a.id
           WHERE a.id = $1`,
          [id],
        )
      ).rows[0] as {
        state: string;
        sha256: string | null;
        byte_size: number | null;
        multipart_upload_id: string;
        declared: string;
      },
  );
const listed = (...sizes: number[]): Part[] =>
  sizes.map((size, index) => ({ number: index + 1, size, etag: `"etag-${index + 1}"` }));
const EXACT = [PART, PART, PART, PART, 6 * MIB];
async function exactUpload(complete_?: "skip" | StorageErrorKind) {
  const id = await startBig();
  faked.parts = listed(...EXACT);
  faked.head = 70 * MIB;
  if (complete_) faked.complete = complete_;
  return id;
}

describe("a file above 64 MiB goes to storage in parts and never through the API", () => {
  it("a 100 MiB upload completes by presigned multipart and the API never reads the body", async () => {
    const body = Buffer.alloc(100 * MIB, "api-never-reads-1-");
    const id = await startBig({ size: body.length, digest: sha(body) });
    const slices = Array.from({ length: Math.ceil(body.length / PART) }, (_, at) =>
      body.subarray(at * PART, (at + 1) * PART),
    );
    const signed = await sign(
      user("editor"),
      id,
      slices.map((slice, at) => ({ number: at + 1, sha256: sha(slice) })),
    );
    expect(signed.status).toBe(200);
    for (const [at, part] of ((await dataOf(signed)).parts as Signed[]).entries())
      expect((await putTo(part, slices[at] as Buffer)).status).toBe(200);
    const done = await complete(user("editor"), id);
    expect(done.status).toBe(200);
    expect(await dataOf(done)).toEqual({ id });
    expect(await assetOf(id)).toMatchObject({ state: "uploaded", sha256: sha(body), byte_size: body.length });
    expect(await real.head(`ws/${ws}/${id}/1/original`)).toMatchObject({ size: body.length });
    // The API handled a few small JSON bodies and wrote no object itself.
    expect(puts).toEqual([]);
    expect(sent).toBeLessThan(4096);
  }, 120_000);

  // [declared size, the answer, what the answer carries]
  it.each([
    ["exactly 64 MiB is one PUT", 64 * MIB, 201, "single"],
    ["64 MiB + 1 is multipart", 64 * MIB + 1, 201, "multipart"],
    ["exactly 5 GiB is multipart", CAP, 201, "multipart"],
    ["5 GiB + 1 is refused", CAP + 1, 422, "refused"],
  ])("register of %s", async (_name, size, status, kind) => {
    const answer = await registerBig({ size });
    expect(answer.status).toBe(status);
    if (kind === "refused") return expect((await errorOf(answer)).code).toBe("unprocessable_content");
    const data = await dataOf(answer);
    expect(data).toHaveProperty(kind === "single" ? "url" : "part_size");
    if (kind === "multipart") expect(data).not.toHaveProperty("url");
  });
});

describe("who may sign a part, and for whose upload", () => {
  it.each(["viewer", "approver"])("a %s cannot register, sign or complete a large upload", async (seat) => {
    const mine = await startBig();
    expect((await registerBig({ who: user(seat) })).status).toBe(403);
    expect((await sign(user(seat), mine, [{ number: 1, sha256: sha("part") }])).status).toBe(403);
    expect((await complete(user(seat), mine)).status).toBe(403);
  });

  it("a part URL of another workspace's or another asset's upload is refused, and complete of a foreign upload looks unknown (floor)", async () => {
    // 64 MiB + 1 byte is four whole parts and a last part of one byte: a cheap body of exactly the signed length.
    const size = 64 * MIB + 1;
    const [mine, theirs] = [
      await startBig({ size }),
      await startBig({ size, who: user("foreign"), workspace: other }),
    ];
    const part = { number: 1, sha256: sha("part") };
    const asked: [string, () => Promise<Response>][] = [
      ["a stranger signing", () => sign(user("outsider"), mine, [part])],
      ["another workspace's member through its own path", () => sign(user("foreign"), mine, [part], other)],
      ["B's upload through A's path, sign", () => sign(user("editor"), theirs, [part])],
      ["a foreign member completing", () => complete(user("foreign"), mine)],
      ["B's upload through A's path, complete", () => complete(user("editor"), theirs)],
    ];
    for (const [label, run] of asked) {
      const answer = await run();
      expect(answer.status, label).toBe(404);
      expect((await errorOf(answer)).code, label).toBe("not_found");
    }
    // A URL minted for one upload is useless against the upload id of another.
    const one = Buffer.from("x");
    const minted = await signedPart(mine, 5, one);
    const url = new URL(minted.url);
    url.searchParams.set("uploadId", (await assetOf(theirs)).multipart_upload_id);
    expect((await putTo(minted, one, url)).status).toBe(403);
    expect((await putTo(minted, one)).status).toBe(200);
  });
});

describe("what a part request may name", () => {
  const part = (number: number, digest = sha("part")) => ({ number, sha256: digest });
  // [what is wrong, the parts, the status, the code]; 70 MiB is five parts.
  it.each([
    ["no part", [], 400, "validation_failed"],
    [
      "more than 20 parts in one call",
      Array.from({ length: 21 }, (_, at) => part(at + 1)),
      400,
      "validation_failed",
    ],
    ["part number 0", [part(0)], 400, "validation_failed"],
    ["part number 321", [part(321)], 400, "validation_failed"],
    ["a sha256 that is not 64 lower-case hex digits", [part(1, "ABC")], 400, "validation_failed"],
    ["a part number beyond the declared five", [part(6)], 422, "unprocessable_content"],
  ])("%s is refused", async (_name, parts, status, code) => {
    const answer = await sign(user("editor"), await startBig(), parts);
    expect([answer.status, (await errorOf(answer)).code]).toEqual([status, code]);
  });

  it.each([
    [
      "a session that expired",
      `UPDATE app.media_uploads SET expires_at = now() - interval '1 minute' WHERE media_id = $1`,
    ],
    ["an upload that is no longer pending", `UPDATE app.media_assets SET state = 'rejected' WHERE id = $1`],
  ])("%s has no part to sign (409)", async (_name, change) => {
    const id = await startBig();
    await fx.admin((client) => client.query(change, [id]));
    expect((await sign(user("editor"), id, [part(1)])).status).toBe(409);
  });

  it("an upload of 64 MiB, which is one PUT, has no part to sign (409)", async () => {
    const single = (await dataOf(await registerBig({ size: 64 * MIB }))).id as string;
    expect((await sign(user("editor"), single, [part(1)])).status).toBe(409);
  });

  it("signs the length the server derives from the declared size, so a body of another length is refused", async () => {
    const short = Buffer.alloc(1024, "short-part-1-");
    const minted = await signedPart(await startBig(), 1, short);
    expect((await putTo(minted, short)).status).toBe(403);
  });
});

describe("complete takes the part list from storage, never from the client (floor)", () => {
  // [what storage lists]; each is refused with the upload aborted and nothing completed.
  it.each([
    ["a missing part", listed(...EXACT).filter((one) => one.number !== 3)],
    ["a part beyond the declared count", [...listed(...EXACT), { number: 6, size: 1, etag: '"etag-6"' }]],
    ["a short middle part", listed(PART, PART - 1, PART, PART, 6 * MIB)],
    ["a last part longer than declared", listed(PART, PART, PART, PART, 6 * MIB + 1)],
    ["no part at all", []],
    ["a total above 5 GiB", listed(...Array.from({ length: 321 }, () => PART))],
  ])("%s answers 409, aborts the upload and completes nothing", async (_name, parts) => {
    const id = await startBig();
    faked.parts = parts;
    const answer = await complete(user("editor"), id);
    expect([answer.status, (await errorOf(answer)).code]).toEqual([409, "conflict"]);
    expect(calls).toContain("abort");
    expect(calls).not.toContain("complete");
    expect((await assetOf(id)).state).toBe("pending_upload");
  });

  it("a list that is exactly 1..n of the declared size is completed with that size and finishes the asset", async () => {
    const id = await exactUpload("skip");
    const answer = await complete(user("editor"), id);
    expect([answer.status, await dataOf(answer)]).toEqual([200, { id }]);
    const stored = await assetOf(id);
    // The parts are the ones storage listed (number and ETag), and the size is the declared one.
    const asListed = listed(...EXACT).map(({ number, etag }) => ({ number, etag }));
    expect(completed).toEqual([
      [`ws/${ws}/${id}/1/original`, stored.multipart_upload_id, asListed, 70 * MIB],
    ]);
    expect(stored).toMatchObject({ state: "uploaded", sha256: stored.declared, byte_size: 70 * MIB });
  });

  // [what storage answers to the complete, the status, whether the upload is aborted]
  it.each([
    ["exists", 409, true],
    ["failed", 503, false],
  ] as const)(
    "a complete that storage refuses as %s, for an object that is not the declared size, answers %s (aborted: %s) and leaves the asset pending",
    async (kind, status, aborted) => {
      const id = await exactUpload(kind);
      faked.head = 70 * MIB - 1;
      expect((await complete(user("editor"), id)).status).toBe(status);
      expect(calls.includes("abort")).toBe(aborted);
      expect((await assetOf(id)).state).toBe("pending_upload");
    },
  );
});

describe("a repeated complete after the answer was lost", () => {
  // Storage no longer has the upload (it completed): the key is headed, and exactly the declared size finishes the asset.
  it.each([
    ["an object of exactly the declared size finishes the asset", 70 * MIB, 200],
    ["an object of another size answers 409", 70 * MIB - 1, 409],
    ["no object answers 409", null, 409],
  ])("%s", async (_name, head, status) => {
    const id = await startBig();
    faked.parts = null;
    faked.head = head;
    expect((await complete(user("editor"), id)).status).toBe(status);
    expect(calls).not.toContain("complete");
    const stored = await assetOf(id);
    expect(stored).toMatchObject(
      status === 200
        ? { state: "uploaded", sha256: stored.declared, byte_size: 70 * MIB }
        : { state: "pending_upload" },
    );
  });

  // The complete itself finds the work done (the key holds the object): the same head decides, and the open upload goes.
  it("a 412 from complete, with an object of exactly the declared size, finishes the asset", async () => {
    const id = await exactUpload("exists");
    expect((await complete(user("editor"), id)).status).toBe(200);
    expect((await assetOf(id)).state).toBe("uploaded");
    expect(calls).toContain("abort");
  });
});

describe("the storage calls of a large upload stay out of the database's transactions (floor)", () => {
  it("creating the upload, listing its parts, completing and heading the object each run with no transaction open", async () => {
    const id = await exactUpload("skip");
    expect((await complete(user("editor"), id)).status).toBe(200);
    expect(calls).toEqual(["create", "list", "complete", "head"]);
    expect(idleInTransaction).toEqual([0, 0, 0, 0]);
  });
});

describe("a register that loses the race for the upload id", () => {
  it("aborts its own upload and answers 409", async () => {
    // Another register of the same asset records its upload id between the create and the record.
    faked.race = async (key) => {
      await fx.admin((client) =>
        client.query(
          `UPDATE app.media_uploads SET multipart_upload_id = 'raced-upload-id-1', declared_sha256 = decode($2, 'hex'),
             declared_size = 1 WHERE media_id = $1`,
          [key.split("/")[2], sha("raced")],
        ),
      );
    };
    expect((await registerBig()).status).toBe(409);
    expect(calls).toContain("abort");
  });
});

describe("a register that storage cannot take leaves no pending asset behind", () => {
  const inState = (state: string) =>
    fx.admin(
      async (client) =>
        (
          await client.query(
            "SELECT count(*)::int AS n FROM app.media_assets WHERE workspace_id = $1 AND state = $2",
            [ws, state],
          )
        ).rows[0].n as number,
    );

  it("answers the storage error and deletes the asset, so an outage never fills the cap of pending uploads", async () => {
    const [pending, deleted] = [await inState("pending_upload"), await inState("deleted")];
    faked.create = "failed";
    expect((await registerBig()).status).toBe(503);
    expect([await inState("pending_upload"), await inState("deleted")]).toEqual([pending, deleted + 1]);
  });
});
