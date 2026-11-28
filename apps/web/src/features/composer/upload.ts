import { z } from "zod";
import { ApiError, request } from "../../http/client";

const registered = z.object({
  id: z.string(),
  duplicate: z.boolean(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  part_size: z.number().optional(),
});
const settled = z.object({ id: z.string(), duplicate: z.boolean() });
const heldParts = z.object({
  part_count: z.number(),
  parts: z.array(z.object({ number: z.number(), size: z.number() })),
});
const partUrls = z.object({
  parts: z.array(
    z.object({ number: z.number(), url: z.string(), headers: z.record(z.string(), z.string()) }),
  ),
});

/** What a later try needs to go on with the same upload instead of starting over. */
export interface Session {
  id: string;
  partSize: number | null;
  url?: string;
  headers?: Record<string, string>;
}

export interface Hooks {
  resume?: Session;
  onSession: (session: Session) => void;
  onProgress: (percent: number) => void;
}

const SEND_TIMEOUT_MS = 10 * 60 * 1000;
const PARTS_PER_CALL = 20;
const PERCENT = 100;

async function sha256Of(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// This server's own address is called like any other call; a storage address in another origin gets the bytes and the
// headers it signed.
async function put(url: string, headers: Record<string, string>, body: Blob): Promise<void> {
  if (url.startsWith("/")) {
    await request(z.unknown(), url, { method: "PUT", body, timeoutMs: SEND_TIMEOUT_MS });
    return;
  }
  const answer = await fetch(url, {
    method: "PUT",
    headers,
    body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!answer.ok) throw new ApiError("service_unavailable", answer.status);
}

async function register(base: string, file: File, sha256: string) {
  return request(registered, base, {
    method: "POST",
    body: {
      file_name: file.name,
      mime: file.type || "application/octet-stream",
      byte_size: file.size,
      sha256,
    },
  });
}

const lengthOf = (size: number, partSize: number, number: number) =>
  Math.min(partSize, size - (number - 1) * partSize);

async function missingParts(base: string, id: string, size: number, partSize: number): Promise<number[]> {
  const held = await request(heldParts, `${base}/${id}/parts`);
  const kept = new Set(
    held.parts
      .filter((part) => part.size === lengthOf(size, partSize, part.number))
      .map((part) => part.number),
  );
  return Array.from({ length: held.part_count }, (_, at) => at + 1).filter((number) => !kept.has(number));
}

async function sendParts(base: string, file: File, session: Session & { partSize: number }, hooks: Hooks) {
  const total = Math.ceil(file.size / session.partSize);
  const todo = await missingParts(base, session.id, file.size, session.partSize);
  let sent = total - todo.length;
  hooks.onProgress(Math.floor((sent * PERCENT) / total));
  for (let at = 0; at < todo.length; at += PARTS_PER_CALL) {
    const batch = todo.slice(at, at + PARTS_PER_CALL);
    const slices = batch.map((number) => ({
      number,
      blob: file.slice((number - 1) * session.partSize, number * session.partSize),
    }));
    const hashed = await Promise.all(
      slices.map(async ({ number, blob }) => ({ number, sha256: await sha256Of(blob) })),
    );
    const urls = await request(partUrls, `${base}/${session.id}/parts`, {
      method: "POST",
      body: { parts: hashed },
    });
    for (const { number, url, headers } of urls.parts) {
      await put(url, headers, slices.find((slice) => slice.number === number)?.blob ?? new Blob());
      sent += 1;
      hooks.onProgress(Math.floor((sent * PERCENT) / total));
    }
  }
}

/**
 * Registers a file, sends its bytes (in parts when the server asks for them, resuming from the parts it holds) and
 * completes it. A file the workspace already has is answered as that file and nothing is sent.
 */
export async function uploadFile(
  workspace: string,
  file: File,
  hooks: Hooks,
): Promise<z.infer<typeof settled>> {
  const base = `/api/v1/workspaces/${workspace}/media`;
  let session = hooks.resume;
  if (session === undefined) {
    const made = await register(base, file, await sha256Of(file));
    if (made.duplicate) return { id: made.id, duplicate: true };
    session = {
      id: made.id,
      partSize: made.part_size ?? null,
      ...(made.url ? { url: made.url } : {}),
      ...(made.headers ? { headers: made.headers } : {}),
    };
    hooks.onSession(session);
  }
  if (session.partSize !== null)
    await sendParts(base, file, { ...session, partSize: session.partSize }, hooks);
  else if (session.url) await put(session.url, session.headers ?? {}, file);
  hooks.onProgress(PERCENT);
  return request(settled, `${base}/${session.id}/complete`, { method: "POST" });
}
