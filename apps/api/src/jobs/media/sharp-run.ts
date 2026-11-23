import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_EXTENSIONS, type ImageType, isImageType, type RejectReason } from "@shoutory/core/media";

// Runs the sharp child (sharp-child.ts) on one file. The child has the server's memory and secrets nowhere in reach: it
// starts with an empty environment, reads one temporary file, writes two, and is killed at its time limit.

const TIME_LIMIT_MS = 30_000;
// The JS heap of the child only; the pixel limit in the child is what bounds the native memory of libvips.
const HEAP_FLAG = "--max-old-space-size=512";
const MAX_ANSWER_BYTES = 4096;
// The same file runs from source (Node strips the types) and, compiled, from dist.
const CHILD = fileURLToPath(
  new URL(`./sharp-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
);

export type SharpResult =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly mime: ImageType;
      readonly files: { readonly stripped: string; readonly thumb: string };
    }
  | { readonly ok: false; readonly reason: RejectReason };

interface Options {
  readonly inputPath: string;
  readonly outputDir: string;
  readonly timeoutMs?: number;
  /** Kills the child when the caller gives up (the relay's handler limit); the run then throws, like any crash. */
  readonly signal?: AbortSignal;
}

const refusal = (reason: RejectReason): SharpResult => ({ ok: false, reason });

/**
 * What the child printed, checked: one of its answers, or undefined when it is not one. The paths of the derivatives are
 * never read from it: the parent builds them from the output folder and the type, so a child that is led astray by an
 * image cannot point the parent at another file.
 */
function parse(text: string, outputDir: string): SharpResult | undefined {
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const reason = answer.reason;
  if (
    answer.ok === false &&
    (reason === "pixel_limit" || reason === "corrupt" || reason === "unsupported_type")
  )
    return refusal(reason);
  const { width, height, mime } = answer as { width: number; height: number; mime: string };
  if (answer.ok !== true || !isImageType(mime) || !(width > 0) || !(height > 0)) return undefined;
  const files = {
    stripped: join(outputDir, `stripped.${IMAGE_EXTENSIONS[mime]}`),
    thumb: join(outputDir, "thumb.webp"),
  };
  return { ok: true, width, height, mime, files };
}

/** Decodes the file in a child process, writes its `stripped` and `thumb` derivatives, and answers the facts or a reason. */
export async function runSharpChild(options: Options): Promise<SharpResult> {
  const child = spawn(process.execPath, [HEAP_FLAG, CHILD, options.inputPath, options.outputDir], {
    env: {},
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    ...(options.signal ? { signal: options.signal, killSignal: "SIGKILL" as const } : {}),
  });
  let out = "";
  child.stdout.on("data", (data: Buffer) => {
    if (out.length < MAX_ANSWER_BYTES) out += data.toString("utf8");
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? TIME_LIMIT_MS);
  const closed = await new Promise<number | null>((done) => {
    child.once("close", done);
    // A child that started is awaited to its `close`, an aborted one too: it is gone when this answers.
    child.once("error", () => child.pid === undefined && done(null));
  });
  clearTimeout(timer);
  // The child answers and exits 0 for every image it judged. An exit that is not 0, a kill by a signal (the memory
  // killer's, say) or an answer that does not parse is a crash of ours, not a corrupt image: it throws, and the asset
  // stays as it was for a retry. Only the time limit, which the parent enforces, is a reason.
  const answer = parse(out, options.outputDir);
  const crashed = !timedOut && (closed !== 0 || answer === undefined);
  if (crashed || timedOut) await clear(options.outputDir);
  if (crashed) throw new Error("the image child crashed");
  return timedOut || answer === undefined ? refusal("timeout") : answer;
}

/** A refused image leaves nothing behind. */
async function clear(dir: string): Promise<void> {
  for (const name of await readdir(dir)) await rm(join(dir, name), { force: true });
}
