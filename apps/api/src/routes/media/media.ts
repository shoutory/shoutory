import { createHash } from "node:crypto";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import type { Logger } from "../../logging/logger.js";
import type { S3Multipart, S3Presigner } from "../../storage/s3-driver.js";
import { type App, defineRoute } from "../define-route.js";
import {
  finishMultipart,
  MAX_MULTIPART_BYTES,
  PART_SIZE,
  registerParts,
  startMultipart,
} from "./multipart.js";
import {
  type Asset,
  assetOf,
  BASE,
  callDefiner,
  conflict,
  EDIT_SPLIT,
  LIVE,
  markUploaded,
  mediaParams,
  originalKey,
  type Scope,
  settled,
  uploadOf,
  VIEW_SPLIT,
  workspaceParams,
} from "./shared.js";

// Media uploads: register an upload (a presigned URL the browser sends the bytes to), complete it, and read the original
// back by range. The bytes never pass through the API on the way in. The digest of an upload is the one storage holds
// for the object (the URL signs the declared sha256, so storage refuses other bytes); the client's claim is never read
// back as the digest. A file above the single-PUT size goes in parts (multipart.ts). A member with library.edit uploads
// and library.view reads.

/** The largest single upload (one PUT; larger files go to storage in parts). */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const registerBody = z.strictObject({
  file_name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}]+$/u),
  mime: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}]+$/u),
  // The cap is the handler's: a file above it is refused as unprocessable, not as a malformed body.
  byte_size: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Where the browser sends the bytes: an S3 upload URL, or on the filesystem driver the PUT route of this API. */
async function uploadTarget(
  presigner: S3Presigner | undefined,
  workspaceId: string,
  mediaId: string,
  declared: { byte_size: number; sha256: string },
): Promise<{ url: string; headers: Record<string, string> }> {
  if (presigner)
    return presigner.presignPut(originalKey(workspaceId, mediaId), declared.byte_size, declared.sha256);
  return {
    url: `/api/v1/workspaces/${workspaceId}/media/${mediaId}/original`,
    headers: { "content-type": "application/octet-stream" },
  };
}

const tooLarge = () =>
  new Refusal("unprocessable_content", "the file is larger than this server takes", {
    details: { reason: "too_large" },
  });

/** What the S3 side of the app can do: sign single uploads, and (when it has them) run multipart uploads. */
interface S3Side {
  presigner: S3Presigner | undefined;
  multipart: S3Multipart | undefined;
  logger: Logger;
}

function registerUpload(app: App, { presigner, multipart, logger }: S3Side): void {
  defineRoute(app, {
    method: "post",
    path: BASE,
    policy: "session",
    access: EDIT_SPLIT,
    params: workspaceParams,
    body: registerBody,
    status: 201,
    handler: async ({ scoped, body }) => {
      // Above the single-PUT size a file goes in parts, and only where storage can take them.
      const large = body.byte_size > MAX_UPLOAD_BYTES;
      if (body.byte_size > MAX_MULTIPART_BYTES || (large && !multipart)) throw tooLarge();
      const made = await scoped(true, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        id: (
          await callDefiner<{ id: string }>(
            tx,
            "SELECT app.media_register($1, $2, $3, 'upload', NULL, NULL, $4) AS id",
            [scope.workspaceId, body.file_name, body.mime, large ? PART_SIZE : null],
          )
        ).id,
      }));
      if (large && multipart) return startMultipart({ multipart, logger }, scoped, made, body);
      const target = await uploadTarget(presigner, made.workspaceId, made.id, body);
      return { id: made.id, url: target.url, headers: target.headers };
    },
  });
}

/**
 * Finishes a pending upload with the size and sha256 storage holds for it. When a complete that ran at the same time
 * finished it first, the definer refuses with a conflict and this answers what that one settled, once.
 */
async function finish(
  storage: StorageDriver,
  workspaceId: string,
  asset: Asset,
  scoped: Scope,
): Promise<{ id: string }> {
  const head = await storage.head(originalKey(workspaceId, asset.id));
  if (!head) throw conflict("no_object");
  if (head.size <= 0) throw conflict("empty");
  if (head.size > MAX_UPLOAD_BYTES) throw conflict("too_large");
  if (!head.sha256) throw conflict("no_checksum");
  return markUploaded(storage, workspaceId, asset, scoped, { sha256: head.sha256, size: head.size });
}

function registerComplete(app: App, storage: StorageDriver, s3: Omit<S3Side, "presigner">): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/{media_id}/complete`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    handler: async ({ scoped, params }) => {
      const { workspaceId, asset, upload } = await scoped(false, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
        upload: await uploadOf(tx, scope.workspaceId, params.media_id),
      }));
      if (asset.state !== "pending_upload") return settled(storage, workspaceId, asset, scoped);
      // A large upload is completed from storage's own part list; every storage call is outside a transaction.
      if (upload?.multipart_upload_id)
        return finishMultipart({ storage, ...s3 }, workspaceId, asset, upload, scoped);
      // The head is outside every transaction: the size and the digest are what storage holds for the object.
      return finish(storage, workspaceId, asset, scoped);
    },
  });
}

type ByteRange = "full" | "unsatisfiable" | { start: number; end: number };

/** RFC 9110 14.1.2 for one range; a syntax this does not serve (several ranges, an inverted one) is read as no range. */
function parseRange(header: string | undefined, size: number): ByteRange {
  const parts = header ? /^bytes=(\d{0,15})-(\d{0,15})$/i.exec(header.trim()) : null;
  if (!parts || (parts[1] === "" && parts[2] === "")) return "full";
  const [, from = "", to = ""] = parts;
  if (from === "") {
    const length = Number(to);
    return length === 0 ? "unsatisfiable" : { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  if (to !== "" && Number(to) < start) return "full";
  if (start >= size) return "unsatisfiable";
  return { start, end: to === "" ? size - 1 : Math.min(Number(to), size - 1) };
}

function registerRead(app: App, storage: StorageDriver): void {
  defineRoute(app, {
    method: "get",
    path: `${BASE}/{media_id}/original`,
    policy: "session",
    access: VIEW_SPLIT,
    params: mediaParams,
    handler: async ({ c, scoped, params }) => {
      const { workspaceId, asset } = await scoped(false, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
      }));
      if (!LIVE.includes(asset.state) || asset.byte_size === null || asset.sha256 === null)
        throw new Refusal("not_found", "media is not uploaded");
      const size = Number(asset.byte_size);
      // RFC 9110 13.1.5: a range is honoured only while If-Range names the current version (the ETag, never a date).
      const ifRange = c.req.header("if-range");
      const current = ifRange === undefined || ifRange.trim() === `"${asset.sha256}"`;
      const asked = current ? c.req.header("range") : undefined;
      const range = parseRange(asked, size);
      if (range === "unsatisfiable")
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      const body = await storage.get(
        originalKey(workspaceId, asset.id),
        range === "full" ? undefined : range,
      );
      if (body === null) throw new Refusal("not_found", "media object is missing");
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        // Bytes a member uploaded are downloaded, never rendered as a page of this origin.
        "content-disposition": "attachment",
        "accept-ranges": "bytes",
        etag: `"${asset.sha256}"`,
        "cache-control": "private, no-cache",
      };
      if (range === "full")
        return new Response(body, { status: 200, headers: { ...headers, "content-length": String(size) } });
      const length = range.end - range.start + 1;
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
          "content-length": String(length),
        },
      });
    },
  });
}

/**
 * The original of an upload is a download, never a page of this origin: the sandbox policy replaces the page policy
 * on it. It must be registered before the secure-headers middleware, which sets the page policy after the handler.
 */
export function sandboxDownloads(app: App): void {
  app.use("/api/v1/workspaces/:workspace_id/media/:media_id/original", async (c, next) => {
    await next();
    c.res.headers.set("content-security-policy", "sandbox");
  });
}

// An upload may be started this long after it was registered, as long as an S3 upload URL lives.
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const OCTET_STREAM = /^application\/octet-stream\s*(;|$)/i;

/** Passes the bytes through while hashing and counting them; the digest is read once the put has finished. */
function hashing(source: ReadableStream<Uint8Array>) {
  const hash = createHash("sha256");
  let size = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        size += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, size: () => size, digest: () => hash.digest("hex") };
}

/**
 * A put that found the object, or whose outcome is unknown (the answer was lost), counts when storage holds exactly the
 * bytes that were streamed: the same size and sha256, which the client never supplies. Anything else is a conflict, and
 * an unknown outcome with no object stays the storage failure it was.
 */
async function settleWrite(
  storage: StorageDriver,
  key: string,
  bytes: ReturnType<typeof hashing>,
  cause: StorageError,
): Promise<void> {
  const head = await storage.head(key);
  if (head === null) throw cause;
  if (head.size === bytes.size() && head.sha256 === bytes.digest()) return;
  throw conflict("different_bytes");
}

/** Writes the original once: a body longer than it declares is 413, and a put that found the object or lost its answer is settled. */
async function storeOriginal(
  storage: StorageDriver,
  key: string,
  body: ReadableStream<Uint8Array>,
  declared: number,
): Promise<void> {
  const bytes = hashing(body);
  try {
    await storage.put(key, bytes.stream, declared, { ifAbsent: true });
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    if (error.kind === "too_large")
      throw new Refusal("payload_too_large", "the body is longer than it declares", { cause: error });
    if (error.kind !== "exists" && error.kind !== "failed") throw error;
    await settleWrite(storage, key, bytes, error);
  }
}

/** The PUT of an upload's bytes to the API (the filesystem driver has no upload URL): streamed, never buffered. */
function registerPut(app: App, storage: StorageDriver, now: () => Date): void {
  defineRoute(app, {
    method: "put",
    path: `${BASE}/{media_id}/original`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    rawBody: { maxBytes: MAX_UPLOAD_BYTES },
    handler: async ({ c, scoped, params }) => {
      const { workspaceId, asset } = await scoped(false, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
      }));
      if (!OCTET_STREAM.test(c.req.header("content-type") ?? ""))
        throw new Refusal("validation_failed", "the body must be application/octet-stream");
      if (asset.state !== "pending_upload") throw conflict("not_pending");
      if (now().getTime() - asset.created_at.getTime() > UPLOAD_WINDOW_MS) throw conflict("expired");
      const body = c.req.raw.body;
      if (body === null) throw new Refusal("validation_failed", "the body is empty");
      // Bounded at the declared length, so a body that lies about it is cut (the limit trusts the header).
      const declared = Number(c.req.header("content-length"));
      await storeOriginal(storage, originalKey(workspaceId, asset.id), body, declared);
      return { id: asset.id };
    },
  });
}

/**
 * The media routes, for either driver: register, complete and the read. Register answers an S3 upload URL when there is
 * a presigner; without one (the filesystem driver) it answers the PUT route of this API, which takes the bytes. With
 * the multipart half of the S3 driver too, a file above 64 MiB registers in parts and has a route to sign them.
 */
export function registerMedia(
  app: App,
  storage: StorageDriver,
  s3: { presigner?: S3Presigner | undefined; multipart?: S3Multipart | undefined; logger: Logger },
  now: () => Date = () => new Date(),
): void {
  const { presigner, multipart, logger } = s3;
  registerUpload(app, { presigner, multipart, logger });
  registerComplete(app, storage, { multipart, logger });
  if (presigner && multipart) registerParts(app, presigner);
  if (!presigner) registerPut(app, storage, now);
  registerRead(app, storage);
}
