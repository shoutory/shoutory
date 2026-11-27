import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { VideoTools } from "@shoutory/core/config";
import {
  claimedType,
  isImageType,
  isVideoType,
  MAX_UPLOAD_BYTES,
  type RejectReason,
  type VideoType,
} from "@shoutory/core/media";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { type TenantTx, withTenant } from "@shoutory/db/context";
import type { AppPool } from "@shoutory/db/pool";
import { fileTypeFromBuffer } from "file-type";
import type { Logger } from "../../logging/logger.js";
import { FAMILY_OF, runProbe, runRemux } from "./probe-run.js";
import type { Scan } from "./scan.js";
import { scratchFor } from "./scratch.js";
import { runSharpChild } from "./sharp-run.js";

// Every step is safe to run again: the state of the asset and of its derivatives says where a crashed run stopped, and
// what it already wrote is never overwritten.

export interface PipelineDeps {
  readonly pool: AppPool;
  readonly storage: StorageDriver;
  // The verdict never blocks an upload; a verdict that is not clean is logged.
  readonly scan?: Scan;
  // Without them a video is refused as an unsupported type.
  readonly video?: VideoTools;
  readonly logger?: Pick<Logger, "warn">;
  readonly scratchDir: string;
}

// `fileTypeFromBuffer` needs no more than this to name any type it knows.
const SAMPLE_BYTES = 4100;
const PROFILES = ["stripped", "thumb"] as const;
type Profile = (typeof PROFILES)[number];

interface Asset {
  state: string;
  mime: string | null;
  object_key: string;
  // For a large upload this is the sender's claim, which the bytes are checked against.
  sha256: string | null;
  // Proved against the stored object when the upload was marked uploaded.
  byte_size: number;
}
const CORRUPT = { ok: false, reason: "corrupt" } as const;
type Job = <T>(run: (tx: TenantTx) => Promise<T>) => Promise<T>;

const keyOf = (original: string, profile: Profile) => original.replace(/original$/, profile);

const sql = <R extends object = object>(job: Job, text: string, values: unknown[]) =>
  job((tx) => tx.query<R & Record<string, unknown>>(text, values));

const readAsset = async (job: Job, ws: string, id: string): Promise<Asset | undefined> =>
  (
    await sql<Asset>(
      job,
      `SELECT state, mime, object_key, encode(sha256, 'hex') AS sha256, byte_size::float8 AS byte_size
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

// The type comes from the bytes, never from what the sender claimed.
async function sniff(storage: StorageDriver, key: string): Promise<string | undefined> {
  const sample = await storage.get(key, { start: 0, end: SAMPLE_BYTES - 1 });
  if (sample === null) throw new Error("the original of an uploaded asset is missing");
  return (await fileTypeFromBuffer(new Uint8Array(await new Response(sample).arrayBuffer())))?.mime;
}

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

// A derivative can be as large as the video it came from, so it is read from disk as the store takes it, and hashed on
// the way; the signal stops the read.
function hashedFile(path: string, signal: AbortSignal | undefined) {
  const hash = createHash("sha256");
  let size = 0;
  async function* chunks() {
    for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
  }
  return {
    body: Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>,
    written: () => ({ digest: hash.digest("hex"), size }),
  };
}

async function putDerivative(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  profile: Profile,
  path: string,
  original: string,
  signal?: AbortSignal,
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
  const key = keyOf(original, profile);
  const file = hashedFile(path, signal);
  let written: { digest: string; size: number };
  try {
    await deps.storage.put(key, file.body, (await stat(path)).size, { ifAbsent: true });
    written = file.written();
  } catch (error) {
    if (!(error instanceof StorageError) || error.kind !== "exists") throw error;
    written = await hashStored(deps.storage, key);
  }
  signal?.throwIfAborted();
  await sql(job, "SELECT app.media_derivative_put($1, $2, $3, 'ready', decode($4, 'hex'), $5, NULL)", [
    ws,
    id,
    profile,
    written.digest,
    written.size,
  ]);
}

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

async function copyOriginal(
  deps: PipelineDeps,
  asset: Asset,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> {
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
  await pipeline(source, counting, createWriteStream(path), signal ? { signal } : {});
  return hash.digest("hex");
}

// Called once the scan of an asset in `scanning` has run, before anything is decoded.
type Scanned = (() => Promise<void>) | undefined;

// The bytes are proved first, whatever way they were uploaded: bytes that are not the asset's sha256 are `corrupt`, and
// nothing is scanned or decoded.
async function withOriginal<T>(
  deps: PipelineDeps,
  ws: string,
  id: string,
  asset: Asset,
  scanned: Scanned,
  signal: AbortSignal | undefined,
  use: (input: string, dir: string) => Promise<T>,
): Promise<T | typeof CORRUPT> {
  const dir = await scratchFor(deps.scratchDir, asset.byte_size);
  try {
    const input = join(dir, "input");
    const digest = await copyOriginal(deps, asset, input, signal);
    if (digest !== asset.sha256) return CORRUPT;
    if (scanned) {
      await warnScan(deps, ws, id, input);
      await scanned();
    }
    return await use(input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function derive(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  asset: Asset,
  scanned: Scanned,
  signal?: AbortSignal,
) {
  return withOriginal(deps, ws, id, asset, scanned, signal, async (input, dir) => {
    const result = await runSharpChild({ inputPath: input, outputDir: dir, ...(signal ? { signal } : {}) });
    if (!result.ok) return result;
    for (const profile of PROFILES)
      await putDerivative(deps, job, ws, id, profile, result.files[profile], asset.object_key, signal);
    return result;
  });
}

type Verdict =
  | {
      ok: true;
      facts: { width: number; height: number; mime: string; duration_ms?: number; codec?: { name: string } };
    }
  | { ok: false; reason: RejectReason };

// ffprobe's facts must agree with what the bytes and the sender said; only then is the copy without metadata made, from
// the same scratch copy, and a video is never ready without it.
async function judgeVideo(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  asset: Asset,
  sniffed: VideoType,
  scanned: Scanned,
  signal?: AbortSignal,
): Promise<Verdict> {
  const tools = deps.video;
  if (tools === undefined) return { ok: false, reason: "unsupported_type" };
  if (sniffed !== claimedType(asset.mime)) return { ok: false, reason: "type_mismatch" };
  const aborts = signal ? { signal } : {};
  return withOriginal(deps, ws, id, asset, scanned, signal, async (inputPath, dir): Promise<Verdict> => {
    const probed = await runProbe({
      ffprobePath: tools.ffprobe,
      inputPath,
      demuxer: FAMILY_OF[sniffed],
      ...aborts,
    });
    if (!probed.ok) return probed;
    if (probed.family !== FAMILY_OF[sniffed]) return { ok: false, reason: "type_mismatch" };
    const outputPath = join(dir, "stripped");
    const copied = await runRemux({
      ffmpegPath: tools.ffmpeg,
      inputPath,
      outputPath,
      type: sniffed,
      ...aborts,
    });
    if (!copied.ok) return copied;
    await putDerivative(deps, job, ws, id, "stripped", outputPath, asset.object_key, signal);
    const { width, height, durationMs, codec } = probed;
    return {
      ok: true,
      facts: { width, height, mime: sniffed, duration_ms: durationMs, codec: { name: codec } },
    };
  });
}

// The type is checked before any pixel is decoded, and the format the decoder then reads must be that type too.
async function judge(
  deps: PipelineDeps,
  job: Job,
  ws: string,
  id: string,
  asset: Asset,
  scanned: Scanned,
  signal?: AbortSignal,
): Promise<Verdict> {
  const sniffed = await sniff(deps.storage, asset.object_key);
  if (sniffed !== undefined && isVideoType(sniffed))
    return judgeVideo(deps, job, ws, id, asset, sniffed, scanned, signal);
  if (sniffed === undefined || !isImageType(sniffed)) return { ok: false, reason: "unsupported_type" };
  if (sniffed !== claimedType(asset.mime)) return { ok: false, reason: "type_mismatch" };
  if (asset.byte_size > MAX_UPLOAD_BYTES) return { ok: false, reason: "too_large" };
  const derived = await derive(deps, job, ws, id, asset, scanned, signal);
  if (!derived.ok) return derived;
  if (derived.mime !== sniffed) return { ok: false, reason: "type_mismatch" };
  return { ok: true, facts: { width: derived.width, height: derived.height, mime: derived.mime } };
}

// An asset that is not `uploaded`, `scanning` or `processing` is left as it is, so a repeated or late call changes
// nothing.
export async function processAsset(
  deps: PipelineDeps,
  workspaceId: string,
  mediaId: string,
  signal?: AbortSignal,
): Promise<void> {
  const job = jobOf(deps, workspaceId);
  await unlessLost(advanceAsset(deps, job, workspaceId, mediaId, signal));
}

// An `uploaded` asset goes through `processing`: the move table has no direct `uploaded` to `rejected`.
export async function failAsset(deps: PipelineDeps, workspaceId: string, mediaId: string): Promise<void> {
  const job = jobOf(deps, workspaceId);
  const state = (await readAsset(job, workspaceId, mediaId))?.state;
  if (state !== "uploaded" && state !== "scanning" && state !== "processing") return;
  await unlessLost(
    (async () => {
      if (state === "uploaded") await advance(job, workspaceId, mediaId, "uploaded", "processing", null);
      const from = state === "scanning" ? "scanning" : "processing";
      await advance(job, workspaceId, mediaId, from, "rejected", "processing_failed");
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

// Two runs of one asset (a retry racing its first run): the loser's refused move is not an error, since the other run
// owns the asset.
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
  const asset = await readAsset(job, workspaceId, mediaId);
  if (asset === undefined) return;
  let state = asset.state;
  if (state === "uploaded") {
    state = deps.scan ? "scanning" : "processing";
    await advance(job, workspaceId, mediaId, "uploaded", state, null);
  }
  if (state !== "scanning" && state !== "processing") return;
  // A resume of a `scanning` asset scans again; one of a `processing` asset does not.
  const scanned =
    state === "scanning"
      ? async () => {
          await advance(job, workspaceId, mediaId, "scanning", "processing", null);
          state = "processing";
        }
      : undefined;
  const verdict = await judge(deps, job, workspaceId, mediaId, asset, scanned, signal);
  if (verdict.ok) await advance(job, workspaceId, mediaId, state, "ready", null, verdict.facts);
  else await advance(job, workspaceId, mediaId, state, "rejected", verdict.reason);
}
