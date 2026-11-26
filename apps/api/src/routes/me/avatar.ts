import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { RejectReason } from "@shoutory/core/media";
import type { StorageDriver } from "@shoutory/core/storage";
import type { TenantTx } from "@shoutory/db/context";
import { fileTypeFromBuffer } from "file-type";
import { Refusal } from "../../errors/refusal.js";
import { ScratchFull, scratchFor } from "../../jobs/media/scratch.js";
import { runSharpChild } from "../../jobs/media/sharp-run.js";
import { type App, defineRoute } from "../define-route.js";
import { inFlightLimit } from "../in-flight.js";

const PATH = "/api/v1/me/avatar";
const MAX_BYTES = 10 * 1024 * 1024;
// `fileTypeFromBuffer` needs no more than this to name any type it knows.
const SAMPLE_BYTES = 4100;
// As long as the web page waits, so a stalled upload frees its slot and its scratch folder.
const RECEIVE_MS = 120_000;
// GIF is decoded for posts, but a profile picture is one still image.
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);

const keyOf = (userId: string) => `users/${userId}/avatar.webp`;
const takeSlot = inFlightLimit(2, "too many profile pictures are being read");

const refused = (reason: RejectReason) =>
  new Refusal("unprocessable_content", `profile picture refused: ${reason}`, { details: { reason } });

const setAt = (tx: TenantTx, at: Date | null) => tx.query("SELECT app.user_avatar_set($1)", [at]);

export async function avatarAtOf(tx: TenantTx, userId: string): Promise<Date | null> {
  const found = await tx.query<{ avatar_at: Date | null }>(
    "SELECT avatar_at FROM app.user_profiles WHERE user_id = $1",
    [userId],
  );
  return found.rows[0]?.avatar_at ?? null;
}

/**
 * Writes the body to `path`, cut at the declared length (the limit trusts the header) and at a deadline, and keeps its
 * first bytes.
 */
async function receive(body: ReadableStream<Uint8Array>, path: string, declared: number): Promise<Buffer> {
  let seen = 0;
  const head: Buffer[] = [];
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > declared)
        return done(new Refusal("payload_too_large", "the body is longer than it declares"));
      if (seen - chunk.length < SAMPLE_BYTES) head.push(chunk);
      done(null, chunk);
    },
  });
  const deadline = AbortSignal.timeout(RECEIVE_MS);
  try {
    await pipeline(
      Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
      bounded,
      createWriteStream(path),
      {
        signal: deadline,
      },
    );
  } catch (error) {
    if (!deadline.aborted) throw error;
    throw new Refusal("validation_failed", "the upload did not arrive in time", { cause: error });
  }
  return Buffer.concat(head).subarray(0, SAMPLE_BYTES);
}

/** The re-encoded thumbnail of the upload; the upload itself is never kept. */
async function decode(body: ReadableStream<Uint8Array>, dir: string, declared: number): Promise<string> {
  const input = join(dir, "input");
  const found = await fileTypeFromBuffer(await receive(body, input, declared));
  if (!found || !ACCEPTED.has(found.mime)) throw refused("unsupported_type");
  const result = await runSharpChild({ inputPath: input, outputDir: dir });
  if (!result.ok) throw refused(result.reason);
  if (result.mime !== found.mime) throw refused("unsupported_type");
  return result.files.thumb;
}

async function scratch(dir: string, size: number): Promise<string> {
  try {
    return await scratchFor(dir, size);
  } catch (error) {
    if (!(error instanceof ScratchFull)) throw error;
    throw new Refusal("service_unavailable", "no scratch room for a profile picture", {
      cause: error,
      retryAfterSeconds: 60,
    });
  }
}

async function store(storage: StorageDriver, key: string, file: string): Promise<void> {
  const size = (await stat(file)).size;
  await storage.put(key, Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, size);
}

export function registerUserAvatar(app: App, storage: StorageDriver, scratchDir: string): void {
  defineRoute(app, {
    method: "put",
    path: PATH,
    policy: "session",
    access: "user",
    cookieOnly: true,
    rawBody: { maxBytes: MAX_BYTES },
    handler: async ({ c, inUserTx }) => {
      const body = c.req.raw.body;
      if (body === null) throw new Refusal("validation_failed", "the body is empty");
      const declared = Number(c.req.header("content-length"));
      const release = takeSlot();
      let dir: string | undefined;
      try {
        dir = await scratch(scratchDir, declared);
        const thumb = await decode(body, dir, declared);
        await store(storage, keyOf(c.get("session").userId), thumb);
      } finally {
        release();
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      }
      const at = new Date();
      await inUserTx((tx) => setAt(tx, at));
      return { avatar_at: at.toISOString() };
    },
  });
  defineRoute(app, {
    method: "delete",
    path: PATH,
    policy: "session",
    access: "user",
    cookieOnly: true,
    handler: async ({ c, inUserTx }) => {
      await inUserTx((tx) => setAt(tx, null));
      await storage.delete(keyOf(c.get("session").userId));
      return new Response(null, { status: 204 });
    },
  });
  defineRoute(app, {
    method: "get",
    path: PATH,
    policy: "session",
    access: "user",
    cookieOnly: true,
    handler: async ({ c, inUserTx }) => {
      const userId = c.get("session").userId;
      const at = await inUserTx((tx) => avatarAtOf(tx, userId));
      if (at === null) throw new Refusal("not_found", "no profile picture");
      const etag = `"${at.getTime()}"`;
      const headers = { etag, "x-content-type-options": "nosniff", "cache-control": "private, no-cache" };
      if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
      const picture = await storage.get(keyOf(userId));
      if (picture === null) throw new Refusal("not_found", "no profile picture");
      return new Response(picture, { headers: { ...headers, "content-type": "image/webp" } });
    },
  });
}
