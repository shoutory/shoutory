import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isImageType, isVideoType, type RejectReason, type VideoType } from "@shoutory/core/media";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import { fileTypeFromBuffer } from "file-type";
import type { Logger } from "../../logging/logger.js";
import { runProbe } from "./probe-run.js";
import type { Scan } from "./scan.js";
import { runSharpChild } from "./sharp-run.js";

// The media pipeline as the worker runs it: one image or video, from `uploaded` to `ready` or `rejected`. It runs as a job of the
// asset's workspace and moves the asset only through the media definers. Every step is safe to run again: the state of
// the asset and of its derivatives says where a crashed run stopped, and what it already wrote is never overwritten.

export interface PipelineDeps {
  readonly pool: AppPool;
  readonly storage: StorageDriver;
  /** The scan hook in `warn` mode (absent: off). Its verdict never blocks an upload; a verdict that is not clean is logged. */
  readonly scan?: Scan;
  /** The absolute path of ffprobe (absent: video probing is off and a video is refused as an unsupported type). */
  readonly ffprobe?: string;
  readonly logger?: Pick<Logger, "warn">;
}

// `fileTypeFromBuffer` needs no more than this to name any type it knows.
const SAMPLE_BYTES = 4100;
const PROFILES = ["stripped", "thumb"] as const;
type Profile = (typeof PROFILES)[number];

interface Asset {
  state: string;
  mime: string | null;
  object_key: string;
  /** The digest the asset was marked uploaded with (hex): the stored one, or for a large upload the sender's claim. */
  sha256: string | null;
}
// The verdict on bytes that are not the ones the asset's digest names.
const CORRUPT = { ok: false, reason: "corrupt" } as const;
type Job = <T>(run: (tx: TenantTx) => Promise<T>) => Promise<T>;

const keyOf = (original: string, profile: Profile) => original.replace(/original$/, profile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream();

/** One statement as the job. */
const sql = <R extends object = object>(job: Job, text: string, values: unknown[]) =>
  job((tx) => tx.query<R & Record<string, unknown>>(text, values));

const readAsset = async (job: Job, ws: string, id: string): Promise<Asset | undefined> =>
  (
    await sql<Asset>(
      job,
      `SELECT state, mime, object_key, encode(sha256, 'hex') AS sha256
       FROM app.media_assets WHERE workspace_id = $1 AND id = $2`,
      [ws, id],
    )
  ).rows[0];

const advance = (
  job: Job,
  ws: string,
  id: string,
  from: string,
  to: string,
  why: string | null,
  facts?: object,
) =>
  sql(job, "SELECT app.media_advance($1, $2, $3, $4, $5, $6::jsonb)", [
    ws,
    id,
    from,
    to,
    why,
    facts && JSON.stringify(facts),
  ]);

/** The type the first bytes of the original name, never the one the sender claimed. */
async function sniff(storage: StorageDriver, key: string): Promise<string | undefined> {
  const sample = await storage.get(key, { start: 0, end: SAMPLE_BYTES - 1 });
  if (sample === null) throw new Error("the original of an uploaded asset is missing");
  return (await fileTypeFromBuffer(new Uint8Array(await new Response(sample).arrayBuffer())))?.mime;
}

/** The hash and size of an object that is already stored (a crashed run left it), read through. */
async function hashStored(storage: StorageDriver, key: string): Promise<{ digest: string; size: number }> {
  const body = await storage.get(key);
  if (body === null) throw new Error("a derivative the store reported is gone");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of Readable.fromWeb(body as NodeReadableStream<Uint8Array>)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { digest: hash.digest("hex"), size };
}

async function putDerivative(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  profile: Profile,
  path: string,
  original: string,
): Promise<void> {
  const known = (
    await sql<{ state: string }>(
      job,
      "SELECT state FROM app.media_derivatives WHERE workspace_id = $1 AND media_id = $2 AND profile = $3",
      [ws, id, profile],
    )
  ).rows[0];
  if (known?.state === "ready") return;
  if (known === undefined)
    await sql(job, "SELECT app.media_derivative_put($1, $2, $3, 'pending', NULL, NULL, NULL)", [
      ws,
      id,
      profile,
    ]);
  const bytes = await readFile(path);
  const key = keyOf(original, profile);
  let written = { digest: sha(bytes), size: bytes.length };
  try {
    await deps.storage.put(key, blob(bytes), bytes.length, { ifAbsent: true });
  } catch (error) {
    if (!(error instanceof StorageError) || error.kind !== "exists") throw error;
    written = await hashStored(deps.storage, key);
  }
  await sql(job, "SELECT app.media_derivative_put($1, $2, $3, 'ready', decode($4, 'hex'), $5, NULL)", [
    ws,
    id,
    profile,
    written.digest,
    written.size,
  ]);
}

/** `warn` mode: scan the original and say so when it is not clean; the upload goes on either way. */
async function warnScan(deps: PipelineDeps, ws: string, id: string, path: string): Promise<void> {
  if (!deps.scan) return;
  try {
    const verdict = await deps.scan(path);
    if (verdict !== "clean")
      deps.logger?.warn({ workspaceId: ws, mediaId: id, verdict }, "upload scan not clean");
  } catch (error) {
    deps.logger?.warn({ workspaceId: ws, mediaId: id, verdict: "failed", err: error }, "upload scan failed");
  }
}

/** Copies the original to `path`, hashing the bytes on the way; the sha256 (hex) of what was copied. */
async function copyOriginal(deps: PipelineDeps, asset: Asset, path: string): Promise<string> {
  const original = await deps.storage.get(asset.object_key);
  if (original === null) throw new Error("the original of an uploaded asset is missing");
  const source = Readable.fromWeb(original as NodeReadableStream<Uint8Array>);
  const hash = createHash("sha256");
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(source, counting, createWriteStream(path));
  return hash.digest("hex");
}

/**
 * Runs `use` on a temporary copy of the original (scanned first on a fresh run) in a folder that is removed after. The
 * bytes are proved first, whatever way they were uploaded: bytes that are not the asset's sha256 are `corrupt`, and
 * nothing is scanned or decoded.
 */
async function withOriginal<T>(
  deps: PipelineDeps,
  ws: string,
  id: string,
  asset: Asset,
  scan: boolean,
  use: (input: string, dir: string) => Promise<T>,
): Promise<T | typeof CORRUPT> {
  const dir = await mkdtemp(join(tmpdir(), "shoutory-media-"));
  try {
    const input = join(dir, "input");
    const digest = await copyOriginal(deps, asset, input);
    if (digest !== asset.sha256) return CORRUPT;
    if (scan) await warnScan(deps, ws, id, input);
    return await use(input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Decodes the original in the sharp child and stores both derivatives; the facts of the image, or why it is refused. */
function derive(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  asset: Asset,
  scan: boolean,
  signal?: AbortSignal,
) {
  return withOriginal(deps, ws, id, asset, scan, async (input, dir) => {
    const result = await runSharpChild({ inputPath: input, outputDir: dir, ...(signal ? { signal } : {}) });
    if (!result.ok) return result;
    for (const profile of PROFILES)
      await putDerivative(deps, job, ws, id, profile, result.files[profile], asset.object_key);
    return result;
  });
}

/** The type a sender claimed, as spelled by a browser or a script: case does not matter, and `image/jpg` is JPEG. */
const claimedType = (mime: string | null): string => {
  const claimed = (mime ?? "").trim().toLowerCase();
  return claimed === "image/jpg" ? "image/jpeg" : claimed;
};

type Verdict =
  | {
      ok: true;
      facts: { width: number; height: number; mime: string; duration_ms?: number; codec?: { name: string } };
    }
  | { ok: false; reason: RejectReason };

// The container family ffprobe names for each video type the pipeline takes.
const FAMILY_OF = { "video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska" } as const;

/**
 * A video is never transcoded or copied: ffprobe reads its facts, and they must agree with what its bytes and the sender
 * said. Without a configured ffprobe a video is not a type this server takes.
 */
async function judgeVideo(
  deps: PipelineDeps,
  ws: string,
  id: string,
  asset: Asset,
  sniffed: VideoType,
  scan: boolean,
  signal?: AbortSignal,
): Promise<Verdict> {
  const ffprobePath = deps.ffprobe;
  if (ffprobePath === undefined) return { ok: false, reason: "unsupported_type" };
  if (sniffed !== claimedType(asset.mime)) return { ok: false, reason: "type_mismatch" };
  const probed = await withOriginal(deps, ws, id, asset, scan, (inputPath) =>
    runProbe({ ffprobePath, inputPath, demuxer: FAMILY_OF[sniffed], ...(signal ? { signal } : {}) }),
  );
  if (!probed.ok) return probed;
  if (probed.family !== FAMILY_OF[sniffed]) return { ok: false, reason: "type_mismatch" };
  const { width, height, durationMs, codec } = probed;
  return {
    ok: true,
    facts: { width, height, mime: sniffed, duration_ms: durationMs, codec: { name: codec } },
  };
}

/**
 * What the asset is: the type its bytes name must be one the pipeline takes and the one the sender claimed, before any
 * pixel is decoded; and the format the decoder then reads must be that type, whatever the bytes of its header said.
 */
async function judge(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  asset: Asset,
  scan: boolean,
  signal?: AbortSignal,
): Promise<Verdict> {
  const sniffed = await sniff(deps.storage, asset.object_key);
  if (sniffed !== undefined && isVideoType(sniffed))
    return judgeVideo(deps, ws, id, asset, sniffed, scan, signal);
  if (sniffed === undefined || !isImageType(sniffed)) return { ok: false, reason: "unsupported_type" };
  if (sniffed !== claimedType(asset.mime)) return { ok: false, reason: "type_mismatch" };
  const derived = await derive(deps, job, ws, id, asset, scan, signal);
  if (!derived.ok) return derived;
  if (derived.mime !== sniffed) return { ok: false, reason: "type_mismatch" };
  return { ok: true, facts: { width: derived.width, height: derived.height, mime: derived.mime } };
}

/**
 * Takes one uploaded asset to `ready` or `rejected`. An asset that is not `uploaded` or `processing` is left as it is, so
 * a repeated or late call changes nothing; a `processing` one (a run that stopped) is continued.
 */
export async function processAsset(
  deps: PipelineDeps,
  workspaceId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<void> {
  const job = jobOf(deps, workspaceId);
  await unlessLost(advanceAsset(deps, job, workspaceId, mediaId, signal));
}

/**
 * The end of the bounded retry: an asset still `uploaded` or `processing` is rejected as `processing_failed` (through
 * `processing`, the one move table has no `uploaded` to `rejected`); one that has finished is left as it is.
 */
export async function failAsset(deps: PipelineDeps, workspaceId: string, mediaId: string): Promise<void> {
  const job = jobOf(deps, workspaceId);
  const state = (await readAsset(job, workspaceId, mediaId))?.state;
  if (state !== "uploaded" && state !== "processing") return;
  await unlessLost(
    (async () => {
      if (state === "uploaded") await advance(job, workspaceId, mediaId, "uploaded", "processing", null);
      await advance(job, workspaceId, mediaId, "processing", "rejected", "processing_failed");
    })(),
  );
}

function jobOf(deps: PipelineDeps, workspaceId: string): Job {
  return (run) =>
    withTenant(
      deps.pool,
      { principalKind: "job", principalId: randomUUID(), workspaceIds: [workspaceId] },
      run,
    );
}

/**
 * Two runs of one asset (a retry racing its first run): the loser's refused move is not an error. It returns at once;
 * the other run owns the asset, and one it leaves `processing` by crashing is the bounded retry's. Any other refusal
 * is rethrown.
 */
async function unlessLost(run: Promise<void>): Promise<void> {
  try {
    await run;
  } catch (error) {
    const refused = error as { code?: string; message?: string };
    const lost = refused.code === "SH409" && /^media_(advance|derivative_put)/.test(refused.message ?? "");
    if (!lost) throw error;
  }
}

async function advanceAsset(
  deps: PipelineDeps,
  job: Job,
  workspaceId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<void> {
  let asset = await readAsset(job, workspaceId, mediaId);
  // The scan belongs to the run that takes the asset out of `uploaded`; a resume of a `processing` one does not repeat it.
  const fresh = asset?.state === "uploaded";
  if (asset && fresh) {
    await advance(job, workspaceId, mediaId, "uploaded", "processing", null);
    asset = { ...asset, state: "processing" };
  }
  if (asset?.state !== "processing") return;
  const verdict = await judge(deps, job, workspaceId, mediaId, asset, fresh, signal);
  if (verdict.ok) await advance(job, workspaceId, mediaId, "processing", "ready", null, verdict.facts);
  else await advance(job, workspaceId, mediaId, "processing", "rejected", verdict.reason);
}
