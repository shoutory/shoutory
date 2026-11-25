import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RejectReason, VideoType } from "@shoutory/core/media";

// The child starts with an empty environment and can open only local files (the image's build has no network protocol,
// and the argv whitelists `file` again). Its output is checked field by field: nothing is trusted beyond the few facts
// the pipeline stores.

const TIME_LIMIT_MS = 15_000;
// A stream copy only reads and writes: a 5 GiB video at 10 MiB/s takes about 8.5 minutes.
const REMUX_LIMIT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
// Any other signal that was not ours (the memory killer's, a stop of the host) says nothing of the file, so the run
// throws and the asset is retried.
const CRASH_SIGNALS: ReadonlySet<string> = new Set(["SIGSEGV", "SIGABRT", "SIGBUS", "SIGFPE", "SIGILL"]);
// The `duration_ms` column is a 32-bit integer.
const MAX_DURATION_MS = 2_147_483_647;

export type ProbeResult =
  | {
      readonly ok: true;
      readonly codec: string;
      readonly width: number;
      readonly height: number;
      readonly durationMs: number;
      readonly family: Family;
    }
  | { readonly ok: false; readonly reason: RejectReason };

// The demuxers the image's build has: `mov` reads mp4 and QuickTime, `matroska` reads webm.
type Family = "mov" | "matroska";
export const FAMILY_OF = { "video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska" } as const;
// The copy keeps the container the sender named, so the stored type stays true.
const MUXER_OF = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" } as const;

interface Options {
  readonly ffprobePath: string;
  readonly inputPath: string;
  // From the type the bytes name: ffprobe is not left to guess it from the content.
  readonly demuxer: Family;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const refusal = (reason: RejectReason): ProbeResult => ({ ok: false, reason });
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCover = (stream: Record<string, unknown>) =>
  isObject(stream.disposition) && stream.disposition.attached_pic === 1;

function lengthMs(format: Record<string, unknown>, stream: Record<string, unknown>): number | undefined {
  const raw = format.duration ?? stream.duration;
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  const ms = Math.round(seconds * 1000);
  return ms > 0 ? ms : undefined;
}

export function parseProbe(json: unknown): ProbeResult {
  if (!isObject(json) || !Array.isArray(json.streams) || !isObject(json.format)) return refusal("corrupt");
  const stream = json.streams.find(
    (candidate): candidate is Record<string, unknown> =>
      isObject(candidate) && candidate.codec_type === "video" && !isCover(candidate),
  );
  if (stream === undefined) return refusal("unsupported_type");
  const { codec_name: codec, width, height } = stream;
  const names = typeof json.format.format_name === "string" ? json.format.format_name.split(",") : [];
  const family = names.includes("mov") ? "mov" : names.includes("matroska") ? "matroska" : undefined;
  const durationMs = lengthMs(json.format, stream);
  if (typeof codec !== "string" || codec === "" || family === undefined || durationMs === undefined)
    return refusal("corrupt");
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1
  )
    return refusal("corrupt");
  if (durationMs > MAX_DURATION_MS) return refusal("too_long");
  return { ok: true, codec, width: width as number, height: height as number, durationMs, family };
}

// The argv is fixed: only the demuxer and the path change. `-f` before the input forces the demuxer (ffprobe
// documentation, "-f format"), and the protocol allowlist is passed whatever the build allows.
const argvFor = (inputPath: string, demuxer: Family) => [
  "-protocol_whitelist",
  "file",
  "-v",
  "error",
  "-of",
  "json",
  "-show_format",
  "-show_streams",
  "-f",
  demuxer,
  inputPath,
];

// Output that is no JSON is a crash of ours, not a verdict on the file.
function parseOutput(output: Buffer): unknown {
  try {
    return JSON.parse(output.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("ffprobe printed no JSON");
    throw error;
  }
}

interface Ended {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly timedOut: boolean;
  readonly tooMuch: boolean;
}

type Tool = "ffprobe" | "ffmpeg";

function runBounded(
  tool: Tool,
  binary: string,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Ended> {
  if (!isAbsolute(binary)) throw new Error(`${tool} is named by an absolute path`);
  const child = spawn(binary, argv, {
    env: {},
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}),
  });
  const chunks: Buffer[] = [];
  let received = 0;
  let tooMuch = false;
  let timerFired = false;
  // A kill of ours is followed by a `close`; an error at any other time is a failure of ours and settles the run.
  let killing = false;
  const stop = () => {
    killing = true;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (tooMuch) return;
    received += chunk.length;
    if (received <= MAX_OUTPUT_BYTES) return void chunks.push(chunk);
    tooMuch = true;
    stop();
  });
  const timer = setTimeout(() => {
    timerFired = true;
    stop();
  }, timeoutMs);
  return new Promise((resolve, reject) => {
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer);
      // The limit counts only when it killed the child: one that exited by itself as the timer fired keeps its verdict.
      const timedOut = timerFired && code === null;
      resolve({ code, signal: closeSignal, stdout: Buffer.concat(chunks), timedOut, tooMuch });
    });
    child.on("error", (error) => {
      if (killing) return;
      clearTimeout(timer);
      if (child.pid !== undefined) child.kill("SIGKILL");
      reject(new Error(`${tool} failed: ${error.message}`));
    });
  });
}

// A file the tool cannot read, or that prints too much or runs too long, is a verdict on the file. A child that cannot
// start or is killed by a signal that was not ours throws, and the asset stays as it was for a retry.
function failureOf(tool: Tool, ended: Ended): RejectReason | undefined {
  if (ended.timedOut) return "timeout";
  if (ended.tooMuch) return "corrupt";
  if (ended.code === null) {
    if (ended.signal !== null && CRASH_SIGNALS.has(ended.signal)) return "corrupt";
    throw new Error(`${tool} was killed by ${ended.signal}`);
  }
  return ended.code === 0 ? undefined : "corrupt";
}

export async function runProbe(options: Options): Promise<ProbeResult> {
  if (!isAbsolute(options.inputPath)) throw new Error("the input of ffprobe is named by an absolute path");
  const ended = await runBounded(
    "ffprobe",
    options.ffprobePath,
    argvFor(options.inputPath, options.demuxer),
    options.timeoutMs ?? TIME_LIMIT_MS,
    options.signal,
  );
  const failure = failureOf("ffprobe", ended);
  return failure ? refusal(failure) : parseProbe(parseOutput(ended.stdout));
}

interface RemuxOptions {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly type: VideoType;
  readonly signal?: AbortSignal;
}

// The first picture that is not a cover (as the probe judged it) and the first sound are copied as they are; no
// container, stream or chapter metadata is carried over, and bitexact keeps the muxer's own tags out. `-n` never
// overwrites a file.
const remuxArgv = ({ inputPath, outputPath, type }: RemuxOptions) => [
  "-nostdin",
  "-n",
  "-protocol_whitelist",
  "file",
  "-f",
  FAMILY_OF[type],
  "-i",
  inputPath,
  "-map",
  "0:V:0",
  "-map",
  "0:a:0?",
  "-sn",
  "-dn",
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
  "-fflags",
  "+bitexact",
  "-c",
  "copy",
  "-f",
  MUXER_OF[type],
  outputPath,
];

// A file the probe passed but that cannot be copied is judged as the probe would judge it.
export async function runRemux(
  options: RemuxOptions,
): Promise<{ ok: true } | { ok: false; reason: RejectReason }> {
  if (!isAbsolute(options.inputPath) || !isAbsolute(options.outputPath))
    throw new Error("the files of ffmpeg are named by absolute paths");
  const ended = await runBounded(
    "ffmpeg",
    options.ffmpegPath,
    remuxArgv(options),
    REMUX_LIMIT_MS,
    options.signal,
  );
  const failure = failureOf("ffmpeg", ended);
  return failure ? refusal(failure) : { ok: true };
}

const hasCode = (error: unknown, ...codes: string[]) =>
  error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");

// A wrong program at the path would otherwise reject every video as corrupt.
async function checkToolPath(tool: Tool, variable: string, path: string): Promise<void> {
  const refused = (why: string) => new Error(`${variable} ${why}`);
  try {
    if (!(await stat(path)).isFile()) throw refused("is not a file");
    await access(path, constants.X_OK);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) throw refused("names no file");
    if (hasCode(error, "EACCES", "EPERM")) throw refused("is not executable");
    throw error;
  }
  const ended = await runBounded(tool, path, ["-version"], TIME_LIMIT_MS);
  const firstLine = ended.stdout.toString("utf8").split("\n", 1)[0] ?? "";
  if (ended.code !== 0 || !firstLine.startsWith(`${tool} version`)) throw refused(`is not a working ${tool}`);
}

export const checkFfprobePath = (path: string) => checkToolPath("ffprobe", "SHOUTORY_FFPROBE_PATH", path);
export const checkFfmpegPath = (path: string) => checkToolPath("ffmpeg", "SHOUTORY_FFMPEG_PATH", path);
