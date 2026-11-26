import { createHash } from "node:crypto";
import { claimedType, isImageType, MAX_UPLOAD_BYTES } from "@shoutory/core/media";
import { type StorageDriver, StorageError } from "@shoutory/core/storage";
import type { TenantTx } from "@shoutory/db/context";
import type { Context, Next } from "hono";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import type { Logger } from "../../logging/logger.js";
import type { S3Multipart, S3Presigner } from "../../storage/s3-driver.js";
import { type App, defineRoute } from "../define-route.js";
import type { Providers } from "../posts/resolve.js";
import { finishFsParts, registerFsParts } from "./fs-parts.js";
import { type ImportFetch, registerImport } from "./import.js";
import { registerLibrary } from "./library.js";
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
  OCTET_STREAM,
  originalKey,
  type Scope,
  type Settled,
  settled,
  uploadOf,
  VIEW_SPLIT,
  workspaceParams,
} from "./shared.js";

// The digest of an upload is the one storage holds for the object (the URL signs the declared sha256, so storage
// refuses other bytes); the client's claim is never read back as the digest.

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

interface S3Side {
  presigner: S3Presigner | undefined;
  multipart: S3Multipart | undefined;
  logger: Logger;
  /** Whether the storage takes a file above 64 MiB in parts: S3 with its multipart half, or the filesystem. */
  parts: boolean;
  /** The most bytes one workspace may store; null is no cap. */
  cap: number | null;
}

// A file already ready in the workspace is answered as that medium: nothing is registered and nothing is uploaded.
// The declared hash only finds it; it is never stored as the digest of a new medium.
async function readyWithHash(tx: TenantTx, workspaceId: string, sha256: string): Promise<string | undefined> {
  const found = await tx.query<{ id: string }>(
    `SELECT id FROM app.media_assets WHERE workspace_id = $1 AND sha256 = decode($2, 'hex') AND state = 'ready'
     ORDER BY created_at LIMIT 1`,
    [workspaceId, sha256],
  );
  return found.rows[0]?.id;
}

async function registered(
  tx: TenantTx,
  workspaceId: string,
  body: z.infer<typeof registerBody>,
  partSize: number | null,
  cap: number | null,
): Promise<string> {
  const made = await callDefiner<{ id: string }>(
    tx,
    "SELECT app.media_register($1, $2, $3, 'upload', NULL, NULL, $4, $5, $6) AS id",
    [workspaceId, body.file_name, body.mime, partSize, body.byte_size, cap],
  );
  return made.id;
}

function registerUpload(app: App, { presigner, multipart, logger, parts, cap }: S3Side): void {
  defineRoute(app, {
    method: "post",
    path: BASE,
    policy: "session",
    access: EDIT_SPLIT,
    params: workspaceParams,
    body: registerBody,
    status: 201,
    handler: async ({ scoped, body }) => {
      const large = body.byte_size > MAX_UPLOAD_BYTES;
      if (body.byte_size > MAX_MULTIPART_BYTES || (large && !parts)) throw tooLarge();
      if (large && isImageType(claimedType(body.mime))) throw tooLarge();
      const made = await scoped(true, async (tx, scope) => {
        const ready = await readyWithHash(tx, scope.workspaceId, body.sha256);
        const id = ready ?? (await registered(tx, scope.workspaceId, body, large ? PART_SIZE : null, cap));
        return { workspaceId: scope.workspaceId, id, duplicate: ready !== undefined };
      });
      if (made.duplicate) return { id: made.id, duplicate: true };
      if (large)
        return { ...(await startMultipart({ multipart, logger }, scoped, made, body)), duplicate: false };
      const target = await uploadTarget(presigner, made.workspaceId, made.id, body);
      return { id: made.id, duplicate: false, url: target.url, headers: target.headers };
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
): Promise<Settled> {
  const head = await storage.head(originalKey(workspaceId, asset.id));
  if (!head) throw conflict("no_object");
  if (head.size <= 0) throw conflict("empty");
  if (head.size > MAX_UPLOAD_BYTES) throw conflict("too_large");
  if (!head.sha256) throw conflict("no_checksum");
  return markUploaded(storage, workspaceId, asset, scoped, { sha256: head.sha256, size: head.size });
}

function registerComplete(app: App, storage: StorageDriver, s3: Pick<S3Side, "multipart" | "logger">): void {
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
      if (upload?.multipart_upload_id)
        return s3.multipart
          ? finishMultipart({ storage, ...s3 }, workspaceId, asset, upload, scoped)
          : finishFsParts({ storage, logger: s3.logger }, workspaceId, asset, upload, scoped);
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
 * The original of an upload and its derivatives are never a page of this origin: the sandbox policy replaces the page
 * policy on them. It must be registered before the secure-headers middleware, which sets the page policy after the handler.
 */
export function sandboxDownloads(app: App): void {
  const sandbox = async (c: Context, next: Next) => {
    await next();
    c.res.headers.set("content-security-policy", "sandbox");
  };
  app.use("/api/v1/workspaces/:workspace_id/media/:media_id/original", sandbox);
  app.use("/api/v1/workspaces/:workspace_id/media/:media_id/derivatives/:profile", sandbox);
}

// An upload may be started this long after it was registered, as long as an S3 upload URL lives.
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

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

function registerPut(app: App, storage: StorageDriver, now: () => Date): void {
  defineRoute(app, {
    method: "put",
    path: `${BASE}/{media_id}/original`,
    policy: "session",
    access: EDIT_SPLIT,
    params: mediaParams,
    rawBody: { maxBytes: MAX_UPLOAD_BYTES },
    handler: async ({ c, scoped, params }) => {
      // A write scope, so an archived workspace takes no bytes.
      const { workspaceId, asset, upload } = await scoped(true, async (tx, scope) => ({
        workspaceId: scope.workspaceId,
        asset: await assetOf(tx, scope.workspaceId, params.media_id),
        upload: await uploadOf(tx, scope.workspaceId, params.media_id),
      }));
      if (!OCTET_STREAM.test(c.req.header("content-type") ?? ""))
        throw new Refusal("validation_failed", "the body must be application/octet-stream");
      if (asset.state !== "pending_upload") throw conflict("not_pending");
      if (now().getTime() - asset.created_at.getTime() > UPLOAD_WINDOW_MS) throw conflict("expired");
      const body = c.req.raw.body;
      if (body === null) throw new Refusal("validation_failed", "the body is empty");
      // Bounded at the declared length, so a body that lies about it is cut (the limit trusts the header).
      const declared = Number(c.req.header("content-length"));
      const registered = upload?.declared_size;
      if (typeof registered === "number" && declared > registered) throw tooLarge();
      await storeOriginal(storage, originalKey(workspaceId, asset.id), body, declared);
      return { id: asset.id };
    },
  });
}

export function registerMedia(
  app: App,
  { storage, providers }: { storage: StorageDriver; providers: Providers },
  s3: {
    presigner?: S3Presigner | undefined;
    multipart?: S3Multipart | undefined;
    mediaImportFetch?: ImportFetch | undefined;
    mediaWorkspaceMaxBytes?: number | undefined;
    logger: Logger;
  },
  now: () => Date = () => new Date(),
): void {
  const { presigner, multipart, logger } = s3;
  const cap = s3.mediaWorkspaceMaxBytes ?? null;
  const fs = storage.name === "fs" && !presigner;
  registerUpload(app, { presigner, multipart, logger, parts: fs || (!!presigner && !!multipart), cap });
  registerComplete(app, storage, { multipart, logger });
  if ((presigner && multipart) || fs)
    registerParts(app, { presigner, multipart: presigner ? multipart : undefined, storage });
  if (!presigner) registerPut(app, storage, now);
  if (fs) registerFsParts(app, storage);
  if (s3.mediaImportFetch) registerImport(app, storage, { getFile: s3.mediaImportFetch, logger, cap });
  registerRead(app, storage);
  registerLibrary(app, storage, providers);
}
