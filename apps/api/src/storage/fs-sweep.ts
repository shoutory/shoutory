import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// The filesystem driver leaves two kinds of file that nothing else removes: the part files of an upload that was never
// completed (`ws/<workspace>/<media>/parts/<n>`) and the temporary file of a write that died (`.<name>.<uuid>.tmp`).
// The sweep removes them once they are older than 7 days. It looks at every entry with `lstat` and never follows or
// removes a link or a junction, stays under `ws/`, and stops at a real-time deadline.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const MAX_DEPTH = 6;
const TEMP = /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

export interface SweepResult {
  /** Files and folders removed. */
  removed: number;
  /** Media folders walked. */
  visited: number;
  /** True when the walk stopped at its deadline. */
  cut: boolean;
}

const gone = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** The names in a folder; none for a folder that is not there. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (gone(error)) return [];
    throw error;
  }
}

/** What the entry is by `lstat`, so a link is never taken for a folder or a file; null once it is gone. */
async function look(path: string) {
  try {
    const stat = await lstat(path);
    return { file: stat.isFile(), folder: stat.isDirectory(), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

/** Removes a file or an empty folder; one that a complete or another sweep removed first is no error. */
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

/** Removes the stale files of one folder and of the folders below it; answers how many entries it removed. */
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

/**
 * The real folders under `dir` (a link is not one), in name order and starting at the folder the day number selects, so a
 * walk that is cut at its deadline begins somewhere else the next day. The deadline is read for every entry listed, and
 * a listing that ran out of time answers null.
 */
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

/**
 * Sweeps `<root>/ws/<workspace>/<media>/`. `now` is the clock (ages are file times, never the wall clock); the deadline
 * runs on real time and is checked before each media folder. A walk that is cut leaves the rest for a later day: the
 * workspace list and each media list begin at an offset of the day number (no stored cursor), so the folders that a
 * cut walk did not reach come first on another day and every folder is reached in the end.
 */
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
