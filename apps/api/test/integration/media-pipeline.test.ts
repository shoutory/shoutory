import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { processAsset } from "../../src/jobs/media/pipeline.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { animatedGif, jpeg, png } from "../support/images.js";
import { seedOrganization, seedWorkspace, signedUser } from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

// `spawn` is wrapped, not replaced: the real child runs, except in the row that makes it crash.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

// The image pipeline as the worker runs it: an uploaded asset is sniffed by its bytes, and what the sender claimed
// is never trusted. The pipeline runs as a job on the worker pool and moves the asset through the definers.

let fx: Fixture;
let ws: string;
let owner: string;
let dir: string;
let storage: ReturnType<typeof createFsDriver>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shoutory-pipeline-"));
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

/** An uploaded original as complete leaves it: the bytes stored, the asset `uploaded` with the mime the sender claimed. */
async function uploaded(bytes: Buffer, claimedMime: string): Promise<string> {
  const id = randomUUID();
  await fx.admin((client) =>
    client.query(
      `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, source, created_by, state, sha256, byte_size)
       VALUES ($1::uuid, $2::uuid, 'ws/' || $2::text || '/' || $1::text || '/1/original', 'p.png', $3, 'upload',
         $4::uuid, 'uploaded', decode($5, 'hex'), $6)`,
      // A hash of its own per asset: the live-hash index is unique, and this slice is not about duplicates.
      [id, ws, claimedMime, owner, createHash("sha256").update(id).digest("hex"), bytes.length],
    ),
  );
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

const run = (id: string) => processAsset({ pool: fx.db.pool("worker"), storage }, ws, id);
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
      await processAsset({ pool: fx.db.pool("worker"), storage, scan: async () => verdict, logger }, ws, id);
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
    const deps = { pool: fx.db.pool("worker"), storage, scan };
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
