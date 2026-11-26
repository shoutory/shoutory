import { createHash } from "node:crypto";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import type { Logger } from "../../logging/logger.js";
import { type App, defineRoute } from "../define-route.js";
import { lengthOf, type OpenUpload, openUpload, PART_SIZE, partCount, partKey } from "./multipart.js";
import {
  type Asset,
  assetOf,
  BASE,
  conflict,
  EDIT_SPLIT,
  markUploaded,
  mediaParams,
  OCTET_STREAM,
  originalKey,
  type Scope,
  type Settled,
  type UploadSession,
  uploadOf,
} from "./shared.js";

// The filesystem driver has no storage-side multipart upload, so the parts come to this API and are kept as files
// under the asset's folder until complete assembles them.

const partParams = z.strictObject({
  ...mediaParams.shape,
  // A plain number, never path text: it becomes the last segment of a storage key.
  number: z.string().regex(/^[1-9][0-9]{0,2}$/),
});

const unprocessable = (reason: string, message: string) =>
  new Refusal("unprocessable_content", message, { details: { reason } });

export function registerFsParts(app: App, storage: StorageDriver): void {
  defineRoute(app, {
    method: "put",
    path: `${BASE}/{media_id}/parts/{number}`,
    policy: "session",
    access: EDIT_SPLIT,
    params: partParams,
    rawBody: { maxBytes: PART_SIZE },
    handler: async ({ c, scoped, params }) => {
      const number = Number(params.number);
      const { workspaceId, asset, upload } = await scoped(false, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
        upload: await uploadOf(tx, scope.workspaceId, params.media_id),
      }));
      if (!OCTET_STREAM.test(c.req.header("content-type") ?? ""))
        throw new Refusal("validation_failed", "the body must be application/octet-stream");
      const open = openUpload(asset, upload);
      if (number > partCount(open))
        throw unprocessable("part_number", "the part is beyond the declared file");
      const declared = Number(c.req.header("content-length"));
      if (declared !== lengthOf(open, number))
        throw unprocessable("part_length", "the part is not the length the declared file gives it");
      const body = c.req.raw.body;
      if (body === null) throw new Refusal("validation_failed", "the body is empty");
      await putPart(storage, partKey(workspaceId, asset.id, number), body, declared);
      return { number };
    },
  });
}

// A part that is in the list but gone from storage is a failure.
async function openPart(storage: StorageDriver, key: string | undefined) {
  if (key === undefined) return null;
  const part = await storage.get(key);
  if (part === null) throw new StorageError("failed");
  return part.getReader();
}

function concatenated(storage: StorageDriver, keys: readonly string[]): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        reader ??= await openPart(storage, keys[next++]);
        if (reader === null) return controller.close();
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        reader = null;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function proving(source: ReadableStream<Uint8Array>, sha256: string) {
  const hash = createHash("sha256");
  const verdict = { mismatch: false };
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (hash.digest("hex") === sha256) return;
        verdict.mismatch = true;
        throw new StorageError("failed");
      },
    }),
  );
  return { stream, verdict };
}

// Every part is checked before one byte of the original is written: a missing part is a conflict, not a half file.
async function requireParts(storage: StorageDriver, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const part = await storage.get(key);
    if (part === null) throw conflict("part_missing");
    await part.cancel();
  }
}

/**
 * The assembly writes a second copy of the file beside its parts. When the disk reports less room than the declared
 * size the complete is refused as unavailable before a byte is written; the parts stay, and a retry works once there is room.
 */
async function requireRoom(
  storage: StorageDriver,
  logger: Pick<Logger, "warn">,
  mediaId: string,
  size: number,
): Promise<void> {
  const { freeBytes } = await storage.check();
  if (freeBytes === null || freeBytes >= size) return;
  logger.warn(
    { mediaId, size, freeBytes },
    "an upload was not assembled: the disk has too little free space",
  );
  throw new Refusal("service_unavailable", "the storage has too little free space to assemble the file");
}

/**
 * Writes the original once from the parts, hashing as it copies. A digest that is not the declared one stores nothing
 * (the driver removes its temporary file); an original that is already there, or an answer that was lost, counts when
 * it is exactly the declared file.
 */
async function assemble(storage: StorageDriver, key: string, keys: readonly string[], open: OpenUpload) {
  const { stream, verdict } = proving(concatenated(storage, keys), open.sha256);
  try {
    await storage.put(key, stream, open.size, { ifAbsent: true });
  } catch (error) {
    if (verdict.mismatch) throw conflict("digest");
    if (!(error instanceof StorageError) || (error.kind !== "exists" && error.kind !== "failed")) throw error;
    const head = await storage.head(key);
    if (head === null) throw error;
    if (head.size !== open.size || head.sha256 !== open.sha256) throw conflict("different_bytes");
  }
}

export async function finishFsParts(
  stores: { storage: StorageDriver; logger: Pick<Logger, "warn"> },
  workspaceId: string,
  asset: Asset,
  upload: UploadSession | undefined,
  scoped: Scope,
): Promise<Settled> {
  const { storage, logger } = stores;
  const open = openUpload(asset, upload);
  const keys = Array.from({ length: partCount(open) }, (_, at) => partKey(workspaceId, asset.id, at + 1));
  await requireParts(storage, keys);
  await requireRoom(storage, logger, asset.id, open.size);
  await assemble(storage, originalKey(workspaceId, asset.id), keys, open);
  const done = await markUploaded(storage, workspaceId, asset, scoped, {
    sha256: open.sha256,
    size: open.size,
  });
  await removeParts(storage, keys, logger, asset.id);
  return done;
}

// A part file that stays is removed by the sweeper after 7 days.
async function removeParts(
  storage: StorageDriver,
  keys: readonly string[],
  logger: Pick<Logger, "warn">,
  mediaId: string,
): Promise<void> {
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (error) {
      const storageError = error instanceof StorageError ? error.kind : "unexpected";
      logger.warn({ mediaId, storageError }, "a part file could not be removed");
    }
  }
}

/**
 * Writes one part, replacing an earlier try of the same number. A body longer than it declares is 413; one that ends
 * short of it is removed and answers 422, so a short part never waits for the digest check of a whole assembly.
 */
async function putPart(
  storage: StorageDriver,
  key: string,
  body: ReadableStream<Uint8Array>,
  declared: number,
): Promise<void> {
  let received = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    await storage.put(key, counted, declared);
  } catch (error) {
    if (error instanceof StorageError && error.kind === "too_large")
      throw new Refusal("payload_too_large", "the body is longer than it declares", { cause: error });
    throw error;
  }
  if (received === declared) return;
  await storage.delete(key);
  throw unprocessable("part_length", "the body ended before the declared part length");
}
