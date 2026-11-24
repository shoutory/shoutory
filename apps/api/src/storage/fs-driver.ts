import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { link, lstat, mkdir, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { checkRange, type StorageDriver, StorageError, storageKeySegments } from "@shoutory/core/storage";

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const isAbsent = (error: unknown) => ABSENT.has((error as NodeJS.ErrnoException | null)?.code ?? "");

async function entry(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

// A link anywhere on the way is refused, so a key cannot reach outside the root through one.
async function folderOf(root: string, folders: string[], create: boolean): Promise<string | null> {
  let path = root;
  for (const name of folders) {
    path = join(path, name);
    const found = await entry(path);
    if (found?.isSymbolicLink()) throw new StorageError("outside_root");
    if (!found) {
      if (!create) return null;
      await mkdir(path, { recursive: true });
    }
  }
  return path;
}

async function fileOf(root: string, key: string): Promise<string | null> {
  const folders = storageKeySegments(key);
  const name = folders.pop() as string;
  const folder = await folderOf(root, folders, false);
  if (folder === null) return null;
  const path = join(folder, name);
  const found = await entry(path);
  if (found?.isSymbolicLink()) throw new StorageError("outside_root");
  return found?.isFile() ? path : null;
}

function bounded(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(new StorageError("too_large"));
      else done(null, chunk);
    },
  });
}

// No path and no system text reach the caller. `link` is how a write that must not replace is made, so a filesystem
// that cannot link (ENOTSUP, EXDEV) cannot hold originals.
function mapped(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  if (code === "EEXIST") return new StorageError("exists");
  if (code === "ENOTSUP" || code === "EXDEV") return new StorageError("unsupported");
  if (code === "EACCES" || code === "EPERM") return new StorageError("denied");
  return new StorageError("failed");
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapped(error);
  }
}

export function createFsDriver(root: string): StorageDriver {
  return {
    name: "fs",
    put: (key, body, maxBytes, options) =>
      guarded(() => putFile(root, key, body, maxBytes, options?.ifAbsent)),
    get: (key, range) => guarded(() => getFile(root, key, range)),
    head: (key) => guarded(() => headFile(root, key)),
    delete: (key) => guarded(() => deleteFile(root, key)),
    async check() {
      try {
        const stats = await statfs(root);
        return { freeBytes: stats.bavail * stats.bsize };
      } catch (error) {
        if (isAbsent(error)) return { freeBytes: null };
        throw error;
      }
    },
  };
}

async function putFile(
  root: string,
  key: string,
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  ifAbsent: boolean | undefined,
): Promise<void> {
  const folders = storageKeySegments(key);
  const name = folders.pop() as string;
  // The root is the operator's mount: a missing one fails here (ENOENT) instead of being created under it.
  await stat(root);
  const folder = (await folderOf(root, folders, true)) as string;
  const target = join(folder, name);
  if ((await entry(target))?.isSymbolicLink()) throw new StorageError("outside_root");
  // Written beside the target and renamed over it, so a reader never sees half an object. A write that must not
  // replace links it instead: `link` fails with EEXIST on every host, where `rename` replaces (or fails with EPERM on
  // Windows).
  const temp = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
    await pipeline(source, bounded(maxBytes), createWriteStream(temp, { flags: "wx" }));
    if (ifAbsent) await link(temp, target);
    else await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // The object is stored; a temporary name that cannot be removed now is left for the sweeper and never fails the write.
  if (ifAbsent) await rm(temp, { force: true }).catch(() => undefined);
}

async function getFile(
  root: string,
  key: string,
  range: { start: number; end: number } | undefined,
): Promise<ReadableStream<Uint8Array> | null> {
  if (range) checkRange(range);
  const path = await fileOf(root, key);
  return path === null ? null : (Readable.toWeb(createReadStream(path, range)) as ReadableStream<Uint8Array>);
}

async function headFile(root: string, key: string): Promise<{ size: number; sha256: string } | null> {
  const path = await fileOf(root, key);
  if (path === null) return null;
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function deleteFile(root: string, key: string): Promise<void> {
  const path = await fileOf(root, key);
  if (path !== null) await unlink(path);
}
