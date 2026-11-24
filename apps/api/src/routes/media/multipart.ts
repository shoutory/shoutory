import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import type { Logger } from "../../logging/logger.js";
import type { S3Multipart, S3Presigner, UploadedPart } from "../../storage/s3-driver.js";
import { type App, defineRoute } from "../define-route.js";
import {
  type Asset,
  assetOf,
  BASE,
  callDefiner,
  conflict,
  EDIT_SPLIT,
  markUploaded,
  mediaParams,
  originalKey,
  type Scope,
  type UploadSession,
  uploadOf,
} from "./shared.js";

// The upload is completed from the part list storage holds, never from a list the client sends. Storage proves each
// part, not the whole object, so the digest declared at register stays unproved until the pipeline hashes the original.

export const MAX_MULTIPART_BYTES = 5 * 1024 * 1024 * 1024;
export const PART_SIZE = 16 * 1024 * 1024;
const MAX_PART_NUMBER = MAX_MULTIPART_BYTES / PART_SIZE;
const MAX_PARTS_PER_CALL = 20;

const partsBody = z.strictObject({
  parts: z
    .array(
      z.strictObject({
        number: z.number().int().min(1).max(MAX_PART_NUMBER),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(MAX_PARTS_PER_CALL),
});

export interface OpenUpload {
  uploadId: string;
  size: number;
  partSize: number;
  sha256: string;
}

export function openUpload(asset: Asset, upload: UploadSession | undefined): OpenUpload {
  if (asset.state !== "pending_upload") throw conflict("not_pending");
  if (!upload?.multipart_upload_id || !upload.part_size || !upload.declared_size || !upload.declared_sha256)
    throw conflict("not_multipart");
  if (!upload.open) throw conflict("expired");
  return {
    uploadId: upload.multipart_upload_id,
    size: upload.declared_size,
    partSize: upload.part_size,
    sha256: upload.declared_sha256,
  };
}

export const partCount = (open: OpenUpload) => Math.ceil(open.size / open.partSize);
export const lengthOf = (open: OpenUpload, number: number) =>
  number < partCount(open) ? open.partSize : open.size - (partCount(open) - 1) * open.partSize;
// The filesystem driver has no storage upload id: its parts are files under the asset.
const FS_UPLOAD_ID = "fs-parts";

// This API's own route, so one client serves both drivers.
const fsPartUrl = (workspaceId: string, mediaId: string, number: number) => ({
  url: `${BASE.replace("{workspace_id}", workspaceId)}/${mediaId}/parts/${number}`,
  headers: { "content-type": "application/octet-stream" },
});

interface Multipart {
  multipart: S3Multipart | undefined;
  logger: Pick<Logger, "warn">;
}

/**
 * Aborts a storage upload the route refuses. An abort that fails never hides the refusal: it is logged (the asset and the
 * class of the failure, never a URL, a key or a credential) and the parts it left age out with the bucket's own rule.
 */
async function abortQuietly(
  { multipart, logger }: { multipart: S3Multipart; logger: Pick<Logger, "warn"> },
  target: { mediaId: string; key: string; uploadId: string },
): Promise<void> {
  try {
    await multipart.abort(target.key, target.uploadId);
  } catch (error) {
    const storageError = error instanceof StorageError ? error.kind : "unexpected";
    logger.warn({ mediaId: target.mediaId, storageError }, "a multipart upload could not be aborted");
  }
}

/**
 * Records the storage upload of a registered large file with the declared digest and size, once. An upload that cannot
 * be recorded (another register won the race) is aborted, so storage keeps nothing.
 */
async function recordUpload(
  stores: Multipart,
  scoped: Scope,
  asset: { workspaceId: string; id: string },
  upload: { key: string; uploadId: string },
  declared: { sha256: string; byte_size: number },
): Promise<void> {
  try {
    await scoped(true, (tx, scope) =>
      callDefiner(tx, "SELECT app.media_set_multipart($1, $2, $3, decode($4, 'hex'), $5) AS id", [
        scope.workspaceId,
        asset.id,
        upload.uploadId,
        declared.sha256,
        declared.byte_size,
      ]),
    );
  } catch (error) {
    if (stores.multipart)
      await abortQuietly(
        { multipart: stores.multipart, logger: stores.logger },
        { mediaId: asset.id, ...upload },
      );
    throw error;
  }
}

/**
 * Retires a registered asset that no storage upload could be made for (the asset is deleted), so an outage of storage
 * never fills the cap of pending uploads. A retire that fails is logged: the asset then ages out at 24 hours.
 */
async function retire(logger: Pick<Logger, "warn">, scoped: Scope, mediaId: string): Promise<void> {
  try {
    await scoped(true, (tx, scope) =>
      callDefiner(tx, "SELECT app.media_advance($1, $2, 'pending_upload', 'deleted', NULL, NULL)", [
        scope.workspaceId,
        mediaId,
      ]),
    );
  } catch (error) {
    const failure = error instanceof Refusal ? error.code : "unexpected";
    logger.warn({ mediaId, failure }, "a pending upload could not be retired");
  }
}

export async function startMultipart(
  stores: Multipart,
  scoped: Scope,
  asset: { workspaceId: string; id: string },
  declared: { sha256: string; byte_size: number },
): Promise<{ id: string; part_size: number }> {
  const key = originalKey(asset.workspaceId, asset.id);
  try {
    const uploadId = stores.multipart ? (await stores.multipart.createUpload(key)).uploadId : FS_UPLOAD_ID;
    await recordUpload(stores, scoped, asset, { key, uploadId }, declared);
  } catch (error) {
    await retire(stores.logger, scoped, asset.id);
    throw error;
  }
  return { id: asset.id, part_size: PART_SIZE };
}

function partsProblem(parts: readonly UploadedPart[], open: OpenUpload): string | undefined {
  if (parts.length !== partCount(open)) return "part_count";
  const wrong = parts.findIndex((part, at) => part.number !== at + 1 || part.size !== lengthOf(open, at + 1));
  return wrong === -1 ? undefined : "part_size";
}

async function markDeclared(
  storage: StorageDriver,
  workspaceId: string,
  asset: Asset,
  open: OpenUpload,
  scoped: Scope,
): Promise<{ id: string }> {
  const head = await storage.head(originalKey(workspaceId, asset.id));
  if (head === null) throw conflict("no_object");
  if (head.size !== open.size) throw conflict("size");
  return markUploaded(storage, workspaceId, asset, scoped, { sha256: open.sha256, size: open.size });
}

export async function finishMultipart(
  stores: { storage: StorageDriver; multipart: S3Multipart | undefined; logger: Pick<Logger, "warn"> },
  workspaceId: string,
  asset: Asset,
  upload: UploadSession | undefined,
  scoped: Scope,
): Promise<{ id: string }> {
  const { storage, multipart, logger } = stores;
  if (!multipart) throw new StorageError("unsupported");
  const open = openUpload(asset, upload);
  const key = originalKey(workspaceId, asset.id);
  const abort = () =>
    abortQuietly({ multipart, logger }, { mediaId: asset.id, key, uploadId: open.uploadId });
  const parts = await multipart.listParts(key, open.uploadId);
  // Storage has no such upload: a complete whose answer was lost finished it, so the object decides.
  if (parts === null) return markDeclared(storage, workspaceId, asset, open, scoped);
  const problem = partsProblem(parts, open);
  if (problem) {
    await abort();
    throw conflict(problem);
  }
  // A 412 means the key already holds an object (an earlier complete finished it): the open upload goes, and the object decides.
  if ((await completeOnce(multipart, key, open, parts)) === "exists") await abort();
  return markDeclared(storage, workspaceId, asset, open, scoped);
}

async function completeOnce(
  multipart: S3Multipart,
  key: string,
  open: OpenUpload,
  parts: readonly UploadedPart[],
): Promise<"done" | "exists"> {
  const listed = parts.map(({ number, etag, checksum }) => ({
    number,
    etag,
    ...(checksum ? { checksum } : {}),
  }));
  try {
    await multipart.complete(key, open.uploadId, listed, open.size);
    return "done";
  } catch (error) {
    if (error instanceof StorageError && error.kind === "exists") return "exists";
    throw error;
  }
}

// On S3 each URL signs that part's sha256 and the length the server derives; on the filesystem the part route checks
// the length itself.
export function registerParts(app: App, presigner: S3Presigner | undefined): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/{media_id}/parts`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    body: partsBody,
    handler: async ({ scoped, params, body }) => {
      const { workspaceId, asset, upload } = await scoped(false, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
        upload: await uploadOf(tx, scope.workspaceId, params.media_id),
      }));
      const open = openUpload(asset, upload);
      if (body.parts.some(({ number }) => number > partCount(open)))
        throw new Refusal("unprocessable_content", "a part number is beyond the parts of the declared file", {
          details: { reason: "part_number" },
        });
      const key = originalKey(workspaceId, asset.id);
      const parts = await Promise.all(
        body.parts.map(async ({ number, sha256 }) => ({
          number,
          ...(presigner
            ? await presigner.presignPart(key, open.uploadId, number, lengthOf(open, number), sha256)
            : fsPartUrl(workspaceId, asset.id, number)),
        })),
      );
      return { parts };
    },
  });
}
