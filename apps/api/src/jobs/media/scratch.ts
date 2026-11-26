import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

const PREFIX = "shoutory-media-";
// Room for the original, one output of its size, and what the decoder and the store need besides.
const MARGIN_BYTES = 256 * 1024 * 1024;
const STALE_MS = 60 * 60 * 1000;

export class ScratchFull extends Error {}

// A run that cannot have the room throws before it writes a byte, so the job retries and in the end fails the asset.
export async function scratchFor(dir: string, byteSize: number): Promise<string> {
  const disk = await statfs(dir);
  const free = disk.bavail * disk.bsize;
  if (free < 2 * byteSize + MARGIN_BYTES)
    throw new ScratchFull(
      `the media scratch folder has ${free} bytes free, too few for an upload of ${byteSize}`,
    );
  return mkdtemp(join(dir, PREFIX));
}

// A run removes its own folder; one that died with the process leaves it, and the next worker start removes it.
export async function sweepScratch(dir: string, now = Date.now()): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(dir, name);
    const found = await stat(path).catch(unlessGone);
    if (found && now - found.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
  }
}

// Another worker starting at the same time may remove an entry between the listing and its stat.
function unlessGone(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
