import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { lstat, mkdir, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { type StorageDriver, StorageError, storageKeySegments } from "@shoutory/core/storage";

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);
const isAbsent = (error: unknown) => ABSENT.has((error as NodeJS.ErrnoException | null)?.code ?? "");

/** What is at `path` without following a link; null when nothing is there. */
async function entry(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

/**
 * The folder that holds the key's file, walked one folder at a time. A link anywhere on the way is refused, so a key
 * cannot reach outside the root through one; a missing folder is created only for a write (null for a read).
 */
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

/** The file of an existing object, or null when there is none; a link in the last place is refused too. */
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

/** Passes bytes through and fails the pipeline as soon as more than `maxBytes` have passed. */
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

/** The default driver: objects are files under `root`, which the operator creates and mounts. */
export function createFsDriver(root: string): StorageDriver {
  return {
    name: "fs",
    async put(key, body, maxBytes) {
      const folders = storageKeySegments(key);
      const name = folders.pop() as string;
      // The root is the operator's mount: a missing one fails here (ENOENT) instead of being created under it.
      await stat(root);
      const folder = (await folderOf(root, folders, true)) as string;
      const target = join(folder, name);
      if ((await entry(target))?.isSymbolicLink()) throw new StorageError("outside_root");
      // Written beside the target and renamed over it, so a reader never sees half an object.
      const temp = join(folder, `.${name}.${randomUUID()}.tmp`);
      try {
        const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
        await pipeline(source, bounded(maxBytes), createWriteStream(temp, { flags: "wx" }));
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async get(key) {
      const path = await fileOf(root, key);
      return path === null ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>);
    },
    async delete(key) {
      const path = await fileOf(root, key);
      if (path !== null) await unlink(path);
    },
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
