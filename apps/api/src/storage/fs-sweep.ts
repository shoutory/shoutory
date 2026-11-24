import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// Nothing else removes the part files of an upload never completed (`ws/<workspace>/<media>/parts/<n>`) or the
// temporary file of a write that died (`.<name>.<uuid>.tmp`). Entries are read with `lstat` so a link or junction is
// never followed or removed.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const MAX_DEPTH = 6;
const TEMP = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export interface SweepResult {
  removed: number;
  visited: number;
  cut: boolean;
}

const gone = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (gone(error)) return [];
    throw error;
  }
}

async function look(path: string) {
  try {
    const stat = await lstat(path);
    return { file: stat.isFile(), folder: stat.isDirectory(), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

// One that a completing upload or another sweep removed first is no error.
async function removeOne(path: string, remove: (path: string) => Promise<void>): Promise<number> {
  try {
    await remove(path);
    return 1;
  } catch (error) {
    if (gone(error)) return 0;
    throw error;
  }
}

interface Walk {
  cutoff: number;
}

async function sweepFolder(dir: string, inParts: boolean, walk: Walk, depth: number): Promise<number> {
  let removed = 0;
  for (const name of await namesIn(dir)) {
    const path = join(dir, name);
    const entry = await look(path);
    if (entry === null) continue;
    if (entry.file && (inParts || TEMP.test(name)) && entry.mtimeMs < walk.cutoff)
      removed += await removeOne(path, unlink);
    else if (entry.folder && depth < MAX_DEPTH)
      removed += await sweepFolder(path, name === "parts" && depth === 0, walk, depth + 1);
    if (entry.folder && name === "parts" && depth === 0 && entry.mtimeMs < walk.cutoff)
      removed += await removeEmpty(path);
  }
  return removed;
}

async function removeEmpty(dir: string): Promise<number> {
  return (await namesIn(dir)).length === 0 ? removeOne(dir, rmdir) : 0;
}

// Starts at the folder the day number selects, so a walk cut at its deadline begins somewhere else the next day and
// every folder is reached in the end (no stored cursor). A listing that ran out of time answers null.
async function foldersIn(dir: string, now: Date, timeUp: () => boolean): Promise<string[] | null> {
  const found: string[] = [];
  for (const name of (await namesIn(dir)).sort()) {
    if (timeUp()) return null;
    const path = join(dir, name);
    if ((await look(path))?.folder) found.push(path);
  }
  const start = found.length === 0 ? 0 : Math.floor(now.getTime() / DAY_MS) % found.length;
  return [...found.slice(start), ...found.slice(0, start)];
}

// Ages are file times compared with `now`; the deadline runs on real time.
export async function sweepStaleFiles(
  root: string,
  now: Date,
  { deadlineMs = DEFAULT_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<SweepResult> {
  const started = Date.now();
  const timeUp = () => Date.now() - started >= deadlineMs;
  const walk = { cutoff: now.getTime() - WEEK_MS };
  const result: SweepResult = { removed: 0, visited: 0, cut: false };
  const top = join(root, "ws");
  // A `ws/` that is a link is never followed: the walk would leave the data folder.
  if (!(await look(top))?.folder) return result;
  const workspaces = await foldersIn(top, now, timeUp);
  if (workspaces === null) return { ...result, cut: true };
  for (const workspace of workspaces) {
    const medias = await foldersIn(workspace, now, timeUp);
    if (medias === null) return { ...result, cut: true };
    for (const media of medias) {
      if (timeUp()) return { ...result, cut: true };
      result.removed += await sweepFolder(media, false, walk, 0);
      result.visited++;
    }
  }
  return result;
}
