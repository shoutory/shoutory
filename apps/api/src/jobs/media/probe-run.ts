import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RejectReason } from "@shoutory/core/media";

// The child starts with an empty environment and can open only local files (the image's build has no network protocol,
// and the argv whitelists `file` again). Its output is checked field by field: nothing is trusted beyond the few facts
// the pipeline stores.

const TIME_LIMIT_MS = 15_000;
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

// The demuxers the image's ffprobe is built with: `mov` reads mp4 and QuickTime, `matroska` reads webm.
type Family = "mov" | "matroska";

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

function runBounded(
  binary: string,
  argv: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Ended> {
  if (!isAbsolute(binary)) throw new Error("ffprobe is named by an absolute path");
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
      reject(new Error(`ffprobe failed: ${error.message}`));
    });
  });
}

// A file ffprobe cannot read, or that prints too much or runs too long, is a verdict on the file. A child that cannot
// start, is killed by a signal that was not ours or prints no JSON throws, and the asset stays as it was for a retry.
export async function runProbe(options: Options): Promise<ProbeResult> {
  if (!isAbsolute(options.inputPath)) throw new Error("the input of ffprobe is named by an absolute path");
  const ended = await runBounded(
    options.ffprobePath,
    argvFor(options.inputPath, options.demuxer),
    options.timeoutMs ?? TIME_LIMIT_MS,
    options.signal,
  );
  if (ended.timedOut) return refusal("timeout");
  if (ended.tooMuch) return refusal("corrupt");
  if (ended.code === null) {
    if (ended.signal !== null && CRASH_SIGNALS.has(ended.signal)) return refusal("corrupt");
    throw new Error(`ffprobe was killed by ${ended.signal}`);
  }
  if (ended.code !== 0) return refusal("corrupt");
  return parseProbe(parseOutput(ended.stdout));
}

const refusedPath = (why: string) => new Error(`SHOUTORY_FFPROBE_PATH ${why}`);
const hasCode = (error: unknown, ...codes: string[]) =>
  error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");

async function checkExecutableFile(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw refusedPath("is not a file");
    await access(path, constants.X_OK);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) throw refusedPath("names no file");
    if (hasCode(error, "EACCES", "EPERM")) throw refusedPath("is not executable");
    throw error;
  }
}

// A wrong program at the path would otherwise reject every video as corrupt.
export async function checkFfprobePath(path: string): Promise<void> {
  await checkExecutableFile(path);
  const ended = await runBounded(path, ["-version"], TIME_LIMIT_MS);
  const firstLine = ended.stdout.toString("utf8").split("\n", 1)[0] ?? "";
  if (ended.code !== 0 || !firstLine.startsWith("ffprobe version"))
    throw refusedPath("is not a working ffprobe");
}
