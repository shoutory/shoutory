import { createHash } from "node:crypto";
import { isImageType, isVideoType } from "@shoutory/core/media";
import type { StorageDriver } from "@shoutory/core/storage";
import type { EgressRequest, EgressResponse } from "@shoutory/provider-sdk/egress";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import type { Logger } from "../../logging/logger.js";
import { type App, defineRoute } from "../define-route.js";
import {
  BASE,
  callDefiner,
  EDIT_SPLIT,
  MAX_UPLOAD_BYTES,
  markUploaded,
  originalKey,
  type Scope,
  workspaceParams,
} from "./shared.js";

// The import of one image or video by URL. The URL is the member's, so the only way to reach it is the egress client under
// the operator policy (the address check, the pinned connection, the redirects, the cap and the time limit). The bytes are
// fetched before anything is written, so a URL that is refused, too large or no media leaves no row and no object. The type
// is the one the bytes have, never the one the host claims, and an encoded body is refused because the bytes would not be
// the ones that were checked. The asset that results is an ordinary upload: uploaded, then the pipeline.

/** The fetch of the import: the egress client bound to the operator policy and a user URL. */
export type ImportFetch = (request: EgressRequest) => Promise<EgressResponse>;

const importBody = z.strictObject({
  url: z.string().min(1).max(2048),
  file_name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
});

/** The whole fetch, body included: a 64 MiB file cannot be moved by the default 15 s on a slow link. */
const IMPORT_TIMEOUT_MS = 60_000;
// `fileTypeFromBuffer` needs no more than this to name any type it knows.
const SAMPLE_BYTES = 4100;
const MAX_NAME_LENGTH = 255;
const MAX_SOURCE_REF = 256;

type Reason = "address_not_allowed" | "too_large" | "unsupported_type" | "fetch_failed";
const refused = (reason: Reason) =>
  new Refusal("unprocessable_content", `import refused: ${reason}`, { details: { reason } });

/** One fixed reason for each egress failure, so the answer is no port scanner and never names the class, host or URL. */
export function reasonOf(error: EgressError): Reason {
  switch (error.class) {
    case "invalid_url":
    case "blocked_url":
    case "blocked_address":
    case "host_not_allowed":
    case "too_many_redirects":
    case "redirect_refused":
      return "address_not_allowed";
    case "size_exceeded":
      return "too_large";
    default:
      return "fetch_failed";
  }
}

/** The name the member gave, else the last segment of the path (never the query or the fragment), else `import`. */
export function fileNameOf(url: string, given?: string): string {
  if (given !== undefined) return given;
  if (!URL.canParse(url)) return "import";
  const last = new URL(url).pathname.split("/").pop() ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch (error) {
    if (error instanceof URIError) return "import";
    throw error;
  }
  return decoded.replace(/\p{Cc}/gu, "").slice(0, MAX_NAME_LENGTH) || "import";
}

/** The origin of the URL (scheme, host, port) and nothing after it: a path or a query can hold a token. */
const originOf = (url: string): string | null => {
  const origin = new URL(url).origin;
  return origin.length <= MAX_SOURCE_REF ? origin : null;
};

/**
 * The bytes of the URL. The request's own signal goes with the time limit, so a client that disconnects ends the fetch
 * (and the slot is handed back) instead of keeping both for the rest of the minute.
 */
async function download(
  getFile: ImportFetch,
  url: string,
  logger: Logger,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let response: EgressResponse;
  try {
    response = await getFile({
      url,
      headers: { "accept-encoding": "identity", accept: "image/*,video/*" },
      timeoutMs: IMPORT_TIMEOUT_MS,
      maxBytes: MAX_UPLOAD_BYTES,
      signal,
    });
  } catch (error) {
    if (!(error instanceof EgressError)) throw error;
    logger.warn({ class: error.class, host: error.host }, "an import was refused");
    throw refused(reasonOf(error));
  }
  if (response.status !== 200) throw refused("fetch_failed");
  const encoding = response.headers["content-encoding"];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== "identity")
    throw refused("unsupported_type");
  return response.body;
}

/** The type of the bytes; anything that is not an image or a video is refused, whatever the host called it. */
async function typeOf(bytes: Uint8Array): Promise<string> {
  const found = await fileTypeFromBuffer(bytes.subarray(0, SAMPLE_BYTES));
  if (!found || !(isImageType(found.mime) || isVideoType(found.mime))) throw refused("unsupported_type");
  return found.mime;
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

async function register(
  scoped: Scope,
  fields: { name: string; mime: string; origin: string | null },
): Promise<string> {
  return (
    await scoped(true, (tx, scope) =>
      callDefiner<{ id: string }>(
        tx,
        "SELECT app.media_register($1, $2, $3, 'url_import', $4, NULL, NULL) AS id",
        [scope.workspaceId, fields.name, fields.mime, fields.origin],
      ),
    )
  ).id;
}

// An import holds its file (up to 64 MiB, about twice that while it is read) for its whole run, so the bound is a memory
// bound and the right level is the process: two at a time, whoever asks. A third is told to try again shortly; fairness
// between workspaces belongs to the rate limits, not to this.
const MAX_IN_FLIGHT = 2;
const RETRY_AFTER_SECONDS = 5;
let inFlight = 0;

/** Takes one of the slots, or refuses with a wait; the returned function hands the slot back (once). */
function takeSlot(): () => void {
  if (inFlight >= MAX_IN_FLIGHT)
    throw new Refusal("too_many_requests", "too many imports are running", {
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
  inFlight++;
  let given = false;
  return () => {
    if (given) return;
    given = true;
    inFlight--;
  };
}

/** Imports one file: fetch, check the type, register, store, mark uploaded; a duplicate answers the live asset. */
export function registerImport(app: App, storage: StorageDriver, getFile: ImportFetch, logger: Logger): void {
  defineRoute(app, {
    method: "post",
    path: `${BASE}/import`,
    policy: "session",
    access: EDIT_SPLIT,
    params: workspaceParams,
    body: importBody,
    status: 201,
    handler: async ({ c, scoped, body }) => {
      // The first scoped call is the authorization: nothing is fetched for a caller who may not import.
      const workspaceId = await scoped(false, async (_tx, scope) => scope.workspaceId);
      const release = takeSlot();
      try {
        const on = { storage, getFile, logger, scoped, workspaceId, signal: c.req.raw.signal };
        return await importOne(on, body);
      } finally {
        release();
      }
    },
  });
}

interface Import {
  storage: StorageDriver;
  getFile: ImportFetch;
  logger: Logger;
  scoped: Scope;
  workspaceId: string;
  signal: AbortSignal;
}

async function importOne(
  { storage, getFile, logger, scoped, workspaceId, signal }: Import,
  body: z.infer<typeof importBody>,
): Promise<{ id: string }> {
  const bytes = await download(getFile, body.url, logger, signal);
  const mime = await typeOf(bytes);
  const name = fileNameOf(body.url, body.file_name);
  const id = await register(scoped, { name, mime, origin: originOf(body.url) });
  await storage.put(originalKey(workspaceId, id), streamOf(bytes), bytes.length, { ifAbsent: true });
  const asset = { id, state: "pending_upload", created_at: new Date(), mime, byte_size: null, sha256: null };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const live = await markUploaded(storage, workspaceId, asset, scoped, { sha256, size: bytes.length });
  logger.info({ mediaId: live.id, host: new URL(body.url).host }, "a file was imported");
  return { id: live.id };
}
