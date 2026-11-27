import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { failAsset, processAsset } from "../../src/jobs/media/pipeline.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { animatedGif, jpeg, png } from "../support/images.js";
import { seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// `spawn` is wrapped, not replaced: the real child runs, except in the row that makes it crash.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

let fx: Fixture;
let ws: string;
let owner: string;
let dir: string;
let scratchDir: string;
let storage: ReturnType<typeof createFsDriver>;
const MIB = 1024 * 1024;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-pipeline-"));
  scratchDir = join(dir, "scratch");
  await mkdir(scratchDir);
  storage = createFsDriver(dir);
  fx = await startFixture({ storage });
  const founder = await signedUser(fx, "pipeline-org");
  owner = founder.id;
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
});
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
});

// `byteSize` is the size the upload was proved to have; a row may plant a size its few bytes stand in for.
async function uploaded(
  bytes: Buffer,
  claimedMime: string,
  declared?: Buffer,
  byteSize = bytes.length,
): Promise<string> {
  const id = randomUUID();
  // The digest of an upload is the hash of its bytes unless a row says what its sender declared.
  const digest = (declared ?? createHash("sha256").update(bytes).digest()).toString("hex");
  await fx.admin(async (client) => {
    // Rows of this file plant the same image again and again, and the live-hash index allows one asset of a hash.
    await client.query(
      "DELETE FROM app.media_assets WHERE workspace_id = $1 AND sha256 = decode($2, 'hex')",
      [ws, digest],
    );
    await client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'p.png', $3, 'upload',
         $4::uuid, 'uploaded', decode($5, 'hex'), $6)`,
      [id, ws, claimedMime, owner, digest, byteSize],
    );
  });
  await storage.put(`ws/${ws}/${id}/1/original`, new Blob([new Uint8Array(bytes)]).stream(), 1024 * 1024);
  return id;
}
const rowOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT a.state, a.reject_reason, (SELECT count(*)::int FROM app.media_derivatives d WHERE d.media_id = a.id) AS derivatives
           FROM app.media_assets a WHERE a.id = $1`,
          [id],
        )
      ).rows[0] as { state: string; reject_reason: string | null; derivatives: number },
  );

const depsWith = (extra: object = {}) => ({ pool: fx.db.pool("worker"), storage, scratchDir, ...extra });
const run = (id: string) => processAsset(depsWith(), ws, id);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const derivativesOf = (id: string) =>
  fx.admin(
    async (client) =>
      (
        await client.query(
          `SELECT profile, state, encode(sha256, 'hex') AS sha256, byte_size::int AS size
           FROM app.media_derivatives WHERE media_id = $1 ORDER BY profile`,
          [id],
        )
      ).rows as { profile: string; state: string; sha256: string; size: number }[],
  );
const bytesOf = async (key: string) => Buffer.from(await new Response(await storage.get(key)).arrayBuffer());

describe("an upload becomes ready", () => {
  it("with its two derivatives recorded by the hash of the stored bytes, the sniffed mime and its size", async () => {
    const id = await uploaded(await jpeg({ gps: true, width: 800, height: 600 }), "image/jpeg");
    await run(id);
    const row = await fx.admin(
      async (client) =>
        (await client.query("SELECT state, mime, width, height FROM app.media_assets WHERE id = $1", [id]))
          .rows[0],
    );
    expect(row).toEqual({ state: "ready", mime: "image/jpeg", width: 800, height: 600 });
    const derivatives = await derivativesOf(id);
    expect(derivatives.map((d) => [d.profile, d.state])).toEqual([
      ["stripped", "ready"],
      ["thumb", "ready"],
    ]);
    for (const derivative of derivatives) {
      const stored = await bytesOf(`ws/${ws}/${id}/1/${derivative.profile}`);
      expect([derivative.sha256, derivative.size]).toEqual([sha(stored), stored.length]);
    }
    // A second run of a finished asset changes nothing.
    await run(id);
    expect((await derivativesOf(id)).length).toBe(2);
  });
});

describe("a crash is not a verdict", () => {
  it("a child that exits non-zero leaves the asset processing and writes nothing, for a retry", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const id = await uploaded(await jpeg(), "image/jpeg");
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
      real.spawn(process.execPath, ["-e", "process.exit(3)"], options as never),
    );
    await expect(run(id)).rejects.toThrow();
    expect(await rowOf(id)).toEqual({ state: "processing", reject_reason: null, derivatives: 0 });
    // The retry, with a healthy child, finishes the asset.
    await run(id);
    expect((await rowOf(id)).state).toBe("ready");
  });
});

// The relay aborts a run whose claim it lost or whose worker stops: the copy and the upload stop too, not only the
// decoder, so nothing is written after the row stopped being this run's.
describe("a run stops when its signal aborts", () => {
  type Stopper = (controller: AbortController) => Partial<typeof storage>;
  it.each<[string, Stopper]>([
    [
      "while the original is copied",
      (controller) => ({
        // The type sniff reads a range first; the copy reads the whole object, which here never ends.
        get: async (key, range) =>
          range
            ? storage.get(key, range)
            : new ReadableStream<Uint8Array>({
                start(stream) {
                  stream.enqueue(new Uint8Array([1]));
                  controller.abort();
                },
              }),
      }),
    ],
    [
      "while a derivative is stored",
      (controller) => ({
        // The abort lands once the object is fully stored, the one moment no stream can notice it.
        put: async (key, body, maxBytes, options) => {
          await storage.put(key, body, maxBytes, options);
          controller.abort();
        },
      }),
    ],
  ])("%s, and records no derivative", async (_name, stopper) => {
    const id = await uploaded(await jpeg(), "image/jpeg");
    const controller = new AbortController();
    const deps = depsWith({ storage: { ...storage, ...stopper(controller) } });
    await expect(processAsset(deps, ws, id, controller.signal)).rejects.toThrow();
    expect((await rowOf(id)).state).toBe("processing");
    expect((await derivativesOf(id)).filter((derivative) => derivative.state === "ready")).toEqual([]);
  });
});

describe("the claimed type may be spelled another way", () => {
  it.each([
    ["in capitals", "IMAGE/PNG", async () => png()],
    ["as image/jpg", "image/jpg", async () => jpeg()],
  ])("%s, and the upload is still ready", async (_name, claimed, make) => {
    const id = await uploaded(await make(), claimed);
    await run(id);
    expect((await rowOf(id)).state).toBe("ready");
  });
});

describe("two runs of one asset at once", () => {
  it("the loser returns at once without an error, and the asset ends ready with two derivatives", async () => {
    const id = await uploaded(await jpeg(), "image/jpeg");
    await expect(Promise.all([run(id), run(id)])).resolves.toHaveLength(2);
    expect((await rowOf(id)).state).toBe("ready");
    expect((await derivativesOf(id)).map((d) => d.state)).toEqual(["ready", "ready"]);
  });
});

describe("an animated upload", () => {
  it("keeps every frame in stripped and its first frame in thumb, with the size of one frame", async () => {
    const id = await uploaded(await animatedGif(3, 40, 30), "image/gif");
    await run(id);
    const row = await fx.admin(
      async (client) =>
        (await client.query("SELECT state, width, height FROM app.media_assets WHERE id = $1", [id])).rows[0],
    );
    expect(row).toEqual({ state: "ready", width: 40, height: 30 });
    const pages = async (profile: string) =>
      (await sharp(await bytesOf(`ws/${ws}/${id}/1/${profile}`), { animated: true }).metadata()).pages ?? 1;
    expect([await pages("stripped"), await pages("thumb")]).toEqual([3, 1]);
  });
});

describe("the scan hook in warn mode", () => {
  it.each(["found", "clean"] as const)(
    "a scan that comes back %s is logged unless clean, and the upload still becomes ready",
    async (verdict) => {
      const id = await uploaded(await jpeg(), "image/jpeg");
      const lines: object[] = [];
      const logger = { warn: (fields: object) => lines.push(fields) };
      await processAsset(depsWith({ scan: async () => verdict, logger }), ws, id);
      expect((await rowOf(id)).state).toBe("ready");
      expect(lines.map((line) => (line as { verdict: string }).verdict)).toEqual(
        verdict === "clean" ? [] : [verdict],
      );
    },
  );
});

describe("the scan runs once", () => {
  it("on the run that moved the asset out of uploaded, and never on a resume", async () => {
    let scans = 0;
    const scan = async () => {
      scans += 1;
      return "clean" as const;
    };
    const deps = depsWith({ scan });
    await processAsset(deps, ws, await uploaded(await jpeg(), "image/jpeg"));
    expect(scans).toBe(1);
    const resumed = await uploaded(await jpeg(), "image/jpeg");
    await fx.admin((client) =>
      client.query("UPDATE app.media_assets SET state = 'processing' WHERE id = $1", [resumed]),
    );
    await processAsset(deps, ws, resumed);
    expect([scans, (await rowOf(resumed)).state]).toEqual([1, "ready"]);
  });
});

describe("an upload that cannot be a picture is rejected with its reason", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
  // The pixel limit and bytes that decode to nothing are the decoder's reasons, tested once in sharp-run.test.ts.
  it("a type outside the supported list, with no derivative written", async () => {
    const id = await uploaded(pdf, "image/png");
    await run(id);
    expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "unsupported_type", derivatives: 0 });
    expect(await storage.head(`ws/${ws}/${id}/1/stripped`)).toBeNull();
  });
});

describe("a pipeline that stopped part way finishes the asset once", () => {
  it.each([
    ["a pending derivative and no object", false],
    ["a pending derivative whose object was already written", true],
  ])("resumes from %s", async (_name, written) => {
    const id = await uploaded(await jpeg(), "image/jpeg");
    await fx.admin(async (client) => {
      await client.query("UPDATE app.media_assets SET state = 'processing' WHERE id = $1", [id]);
      await client.query(
        `INSERT INTO app.media_derivatives (workspace_id, media_id, profile, object_key)
         VALUES ($1::uuid, $2::uuid, 'stripped', 'ws/' || $1::text || '/' || $2::text || '/1/stripped')`,
        [ws, id],
      );
    });
    if (written)
      await storage.put(`ws/${ws}/${id}/1/stripped`, new Blob(["left by the crash"]).stream(), 1024);
    await run(id);
    expect((await rowOf(id)).state).toBe("ready");
    const derivatives = await derivativesOf(id);
    expect(derivatives.map((d) => [d.profile, d.state])).toEqual([
      ["stripped", "ready"],
      ["thumb", "ready"],
    ]);
    // Whatever is stored is what is recorded, an object the crash left included.
    const stripped = await bytesOf(`ws/${ws}/${id}/1/stripped`);
    expect(derivatives[0]?.sha256).toBe(sha(stripped));
  });
});

// A video is judged from what ffprobe reports about its bytes. The real binary lives in the image (its own smoke test
// runs it); here the child that would run it prints an answer recorded from that binary, through the real `runProbe`.
const fixture = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url));
const recorded = (name: string) => JSON.parse(fixture(`ffprobe/${name}.json`).toString("utf8")) as ProbeJson;
interface ProbeJson {
  streams: object[];
  format: object;
}
const mp4 = fixture("h264.mp4");
const withBrand = (brand: string) => {
  const copy = Buffer.from(mp4);
  copy.write(brand, 8, "latin1");
  return copy;
};
// The first bytes of a webm: enough for the sniffer, which is all the pipeline reads of it before the probe.
const WEBM = Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878102", "hex");

async function probePrints(output: unknown, exitCode = 0) {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const text = typeof output === "string" ? output : JSON.stringify(output);
  vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
    real.spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(text)});process.exit(${exitCode})`],
      options as never,
    ),
  );
}
// The copy's fake child writes known bytes where ffmpeg would write the stripped file (the last argument).
async function remuxWrites(bytes: Buffer, exitCode = 0) {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementationOnce((_command, args, options) => {
    const out = JSON.stringify((args as string[]).at(-1));
    const write = `require("node:fs").writeFileSync(${out},Buffer.from("${bytes.toString("hex")}","hex"))`;
    return real.spawn(process.execPath, ["-e", `${write};process.exit(${exitCode})`], options as never);
  });
}
const COPY = Buffer.from("the stripped copy of the video");
const TOOLS = { video: { ffprobe: process.execPath, ffmpeg: process.execPath } };
const runVideo = (id: string, extra: object = TOOLS) => processAsset(depsWith(extra), ws, id);

// A block, not an arrow with a value: a function that a hook returns is run after the test as its cleanup.
beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

describe("an uploaded video becomes ready", () => {
  it.each([
    ["an mp4", () => mp4, "video/mp4", "h264.mp4", "h264", "mov", "mp4"],
    ["a QuickTime movie", () => withBrand("qt  "), "video/quicktime", "hevc.mov", "hevc", "mov", "mov"],
    ["a webm", () => WEBM, "video/webm", "vp9.webm", "vp9", "matroska", "webm"],
  ])(
    "%s becomes ready with its size, length and codec and its stripped copy, and a second run changes nothing",
    async (_name, bytes, mime, file, codec, demuxer, muxer) => {
      const id = await uploaded(bytes(), mime);
      await probePrints(recorded(file));
      await remuxWrites(COPY);
      await runVideo(id);
      // The demuxer is the one of the type the bytes name, set before the input.
      expect(vi.mocked(spawn).mock.calls[0]?.[1]?.slice(-3, -1)).toEqual(["-f", demuxer]);
      // The copy reads the same scratch copy the probe judged and writes beside it, in the sender's container.
      const copyArgv = vi.mocked(spawn).mock.calls[1]?.[1] as string[];
      const input = copyArgv[copyArgv.indexOf("-i") + 1] as string;
      expect([input.startsWith(join(scratchDir, "shoutory-media-")), copyArgv.slice(-3)]).toEqual([
        true,
        ["-f", muxer, join(input, "..", "stripped")],
      ]);
      const row = await fx.admin(
        async (client) =>
          (
            await client.query(
              "SELECT state, mime, width, height, duration_ms, codec_facts, byte_size::int FROM app.media_assets WHERE id = $1",
              [id],
            )
          ).rows[0],
      );
      expect(row).toEqual({
        state: "ready",
        mime,
        width: 320,
        height: 240,
        duration_ms: 2000,
        codec_facts: { name: codec },
        byte_size: bytes().length,
      });
      expect(await derivativesOf(id)).toEqual([
        { profile: "stripped", state: "ready", sha256: sha(COPY), size: COPY.length },
      ]);
      expect(await bytesOf(`ws/${ws}/${id}/1/stripped`)).toEqual(COPY);
      await runVideo(id);
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );
});

const h264 = recorded("h264.mp4");
// [what is wrong, the bytes, what the sender claimed, what ffprobe prints (none: it is never asked), the reason]
const REFUSED: [
  string,
  () => Promise<Buffer>,
  string,
  { out: unknown; exit?: number } | undefined,
  string,
][] = [
  ["an mp4 claimed as QuickTime", async () => mp4, "video/quicktime", undefined, "type_mismatch"],
  ["a video claimed as an image", async () => mp4, "image/png", undefined, "type_mismatch"],
  ["an image claimed as a video", () => jpeg(), "video/mp4", undefined, "type_mismatch"],
  [
    "a video type outside the supported list (3GP)",
    async () => withBrand("3gp5"),
    "video/3gpp",
    undefined,
    "unsupported_type",
  ],
  ["a webm whose probe names the mov family", async () => WEBM, "video/webm", { out: h264 }, "type_mismatch"],
  [
    "an mp4 whose probe names the matroska family",
    async () => mp4,
    "video/mp4",
    { out: recorded("vp9.webm") },
    "type_mismatch",
  ],
  [
    "a truncated mp4 that ffprobe cannot read",
    async () => mp4.subarray(0, mp4.length / 2),
    "video/mp4",
    { out: recorded("truncated.mp4"), exit: 1 },
    "corrupt",
  ],
];

describe("an uploaded video the pipeline refuses", () => {
  it.each(REFUSED)(
    "%s is rejected with its reason and no derivative",
    async (_name, bytes, claimed, probe, reason) => {
      const id = await uploaded(await bytes(), claimed);
      if (probe) await probePrints(probe.out, probe.exit);
      await runVideo(id);
      expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: reason, derivatives: 0 });
      expect(spawn).toHaveBeenCalledTimes(probe ? 1 : 0);
    },
  );

  it("is rejected as an unsupported type, with no child run, when the video tools are off", async () => {
    const id = await uploaded(mp4, "video/mp4");
    await runVideo(id, {});
    expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "unsupported_type", derivatives: 0 });
    expect(spawn).not.toHaveBeenCalled();
  });

  // Never ready without its copy: a copy that fails leaves no derivative behind.
  it("that probed fine but cannot be copied is rejected corrupt, with no derivative", async () => {
    const id = await uploaded(mp4, "video/mp4");
    await probePrints(h264);
    await remuxWrites(Buffer.from("half a file"), 1);
    await runVideo(id);
    expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "corrupt", derivatives: 0 });
    expect(await storage.head(`ws/${ws}/${id}/1/stripped`)).toBeNull();
  });
});

describe("the run of an uploaded video", () => {
  it("stays processing when the probe prints no JSON, and the retry finishes it", async () => {
    const id = await uploaded(mp4, "video/mp4");
    await probePrints("not json");
    await expect(runVideo(id)).rejects.toThrow();
    expect(await rowOf(id)).toEqual({ state: "processing", reject_reason: null, derivatives: 0 });
    await probePrints(h264);
    await remuxWrites(COPY);
    await runVideo(id);
    expect((await rowOf(id)).state).toBe("ready");
  });

  it("is seen once by the scan hook", async () => {
    let scans = 0;
    const scan = async () => {
      scans += 1;
      return "clean" as const;
    };
    const id = await uploaded(mp4, "video/mp4");
    await probePrints(h264);
    await remuxWrites(COPY);
    await runVideo(id, { ...TOOLS, scan });
    expect([scans, (await rowOf(id)).state]).toEqual([1, "ready"]);
  });
});

// A large upload reaches `uploaded` with the digest its sender declared (storage proved each part, not the whole), so
// the pipeline hashes every original it copies, whatever way the upload came in.
async function uploadedWith(bytes: Buffer, digest: Buffer, session: boolean): Promise<string> {
  const id = await uploaded(bytes, "image/jpeg", digest);
  if (session)
    await fx.admin((client) =>
      client.query(
        `INSERT INTO app.media_uploads (workspace_id, media_id, multipart_upload_id, part_size, expires_at)
         VALUES ($1, $2, 'storage-upload-id-1', 16777216, now() + interval '1 day')`,
        [ws, id],
      ),
    );
  return id;
}

describe("the pipeline proves the digest of every upload", () => {
  it.each([
    ["a large upload", true],
    ["a single PUT", false],
  ])(
    "%s whose bytes differ from its sha256 ends rejected corrupt, with no image decoded (floor)",
    async (_name, session) => {
      const id = await uploadedWith(
        await jpeg(),
        createHash("sha256").update("not the bytes").digest(),
        session,
      );
      await run(id);
      expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "corrupt", derivatives: 0 });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("makes an upload ready when its bytes are the sha256 it carries", async () => {
    const bytes = await jpeg();
    const id = await uploadedWith(bytes, createHash("sha256").update(bytes).digest(), true);
    await run(id);
    expect((await rowOf(id)).state).toBe("ready");
  });
});

describe("the claimed type of an upload is never trusted", () => {
  it("bytes that are not their claimed type are rejected, with no derivative written", async () => {
    // JPEG bytes sent as a PNG: the first bytes name the type, whatever the sender said.
    const id = await uploaded(await jpeg(), "image/png");
    await run(id);
    expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "type_mismatch", derivatives: 0 });
    for (const profile of ["stripped", "thumb"])
      expect(await storage.head(`ws/${ws}/${id}/1/${profile}`)).toBeNull();
  });
});

// A scan that records what it was given: the path, or what `look` reads while it runs.
const counting = (look: (path: string) => Promise<string> | string = (path) => path) => {
  const seen: string[] = [];
  const scan = async (path: string) => {
    seen.push(await look(path));
    return "clean" as const;
  };
  return { seen, scan };
};

describe("a run never takes more memory or disk than it may (floor)", () => {
  it("an image proved larger than 64 MiB is rejected too_large, and is never copied, scanned or decoded", async () => {
    const { seen, scan } = counting();
    const id = await uploaded(await jpeg(), "image/jpeg", undefined, 64 * MIB + 1);
    await processAsset(depsWith({ scan }), ws, id);
    expect(await rowOf(id)).toEqual({ state: "rejected", reject_reason: "too_large", derivatives: 0 });
    expect([seen, vi.mocked(spawn).mock.calls.length]).toEqual([[], 0]);
  });

  it.each([
    ["less free space than twice its size and a margin", () => scratchDir, 2 ** 50],
    ["a scratch folder whose free space cannot be read", () => join(dir, "missing"), mp4.length],
  ])("a run with %s throws before any byte is written, for the retry", async (_n, folder, size) => {
    const id = await uploaded(mp4, "video/mp4", undefined, size);
    await expect(runVideo(id, { ...TOOLS, scratchDir: folder() })).rejects.toThrow();
    expect(await rowOf(id)).toEqual({ state: "processing", reject_reason: null, derivatives: 0 });
    expect(await readdir(scratchDir)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("copies the original only under the scratch folder, and removes the copy when done", async () => {
    const { seen, scan } = counting();
    const id = await uploaded(await jpeg(), "image/jpeg");
    await processAsset(depsWith({ scan }), ws, id);
    expect(seen.map((path) => path.startsWith(join(scratchDir, "shoutory-media-")))).toEqual([true]);
    expect([(await rowOf(id)).state, await readdir(scratchDir)]).toEqual(["ready", []]);
  });
});

describe("an asset being scanned", () => {
  const stateOf = async (id: string) => (await rowOf(id)).state;

  it("is in scanning while the scanner reads it, then becomes ready", async () => {
    const id = await uploaded(await jpeg(), "image/jpeg");
    const { seen, scan } = counting(() => stateOf(id));
    await processAsset(depsWith({ scan }), ws, id);
    expect([seen, await stateOf(id)]).toEqual([["scanning"], "ready"]);
  });

  it("is scanned again on the resume of a run that stopped there, and becomes ready", async () => {
    const { seen, scan } = counting();
    const id = await uploaded(await jpeg(), "image/jpeg");
    await fx.admin((client) =>
      client.query("UPDATE app.media_assets SET state = 'scanning' WHERE id = $1", [id]),
    );
    await processAsset(depsWith({ scan }), ws, id);
    expect([seen.length, await stateOf(id)]).toEqual([1, "ready"]);
  });

  it("ends rejected processing_failed when its run fails for good", async () => {
    const id = await uploaded(await jpeg(), "image/jpeg");
    await fx.admin((client) =>
      client.query("UPDATE app.media_assets SET state = 'scanning' WHERE id = $1", [id]),
    );
    await failAsset(depsWith(), ws, id);
    expect(await rowOf(id)).toEqual({
      state: "rejected",
      reject_reason: "processing_failed",
      derivatives: 0,
    });
  });
});
