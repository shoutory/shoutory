import {
  type AdapterContext,
  type CommitInput,
  type ConnectAdapter,
  type InspectInput,
  type MediaItem,
  MediaReadError,
  type MediaReader,
  type ProviderAdapter,
  type RemotePost,
  type VerifySecretInput,
} from "@shoutory/provider-sdk/adapter";
import { isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { discordManifest } from "./manifest.js";

// Built from https://docs.discord.com/developers/resources/webhook (execute, get, edit and delete a webhook message),
// /topics/rate-limits (429 body and headers, the invalid-request limit), /topics/opcodes-and-status-codes (JSON error
// codes) and /reference (User-Agent, file uploads), all read 2026-11-27. The webhook URL is the credential: its id and
// token are read from it for each call, only to build the request path, and never reach a result, error or log line.

const NO_EFFECT = { effect: "none" } as const;
const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);
const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);
const USER_AGENT = "DiscordBot (https://github.com/shoutory/shoutory, 1.0)";
const UNKNOWN_WEBHOOK = 10015;
const INVALID_WEBHOOK_TOKEN = 50027;
const MAX_ANSWER_BYTES = 512 * 1024;

const SNOWFLAKE = /^\d{17,20}$/;
const WEBHOOK_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{1,128})$/;

interface Webhook {
  readonly host: string;
  readonly id: string;
  readonly token: string;
}

// Only an https URL of a host the manifest names, with no userinfo, port, query or fragment, whose path is exactly a
// webhook's. Anything else could send the token somewhere else or name another route.
function webhookOf(secret: string): Webhook | undefined {
  if (secret.includes("?") || secret.includes("#") || !URL.canParse(secret)) return undefined;
  const url = new URL(secret);
  const match = WEBHOOK_PATH.exec(url.pathname);
  const plain = url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "";
  const [, id, token] = match ?? [];
  const allowed = (discordManifest.egressHosts ?? []).includes(url.hostname);
  return plain && allowed && id !== undefined && token !== undefined
    ? { host: url.hostname, id, token }
    : undefined;
}

const refusedInput = (): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "invalid_input" });
const unknown = (): ProviderResult => errorResult({ effect: "possible", errorClass: "unknown" });
const unusable = (): ProviderResult => errorResult({ ...NO_EFFECT, errorClass: "unknown" });

// Anything not classed here is a bug and throws.
function networkFailure(error: unknown, sent: boolean): ProviderResult {
  if (isPolicyRefusal(error)) {
    return errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "address_not_allowed" });
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const named = typeof code === "string" ? code : "";
  const beforeSend = errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" });
  if (NOT_SENT.has(named)) return beforeSend;
  const deadline = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (deadline || CUT_OFF.has(named)) return sent ? unknown() : beforeSend;
  throw error;
}

// A body over the bound, or one that is not JSON, is no answer.
async function answerJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// Only the numeric code and the retry delay are read from an error body; its text is never carried into a result.
const errorBody = z.object({
  code: z.int().optional().catch(undefined),
  retry_after: z.number().optional().catch(undefined),
});

function delayMs(bodyDelay: number | undefined, headers: Headers, now: Date): number | undefined {
  if (bodyDelay !== undefined && Number.isFinite(bodyDelay) && bodyDelay >= 0) {
    return Math.ceil(bodyDelay * 1000);
  }
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  if (/^\d+$/.test(after)) return Number(after) * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

interface Failure {
  readonly status: number;
  readonly code: number | undefined;
  readonly headers: Headers;
  readonly retryAfter: number | undefined;
}

// A 429 of the shared scope is the resource's limit, not ours: it is waited out like any other and does not count towards
// the invalid-request ban. A 401, or the code for an unknown webhook or invalid token on any 4xx, means the webhook is gone; a 403 refuses this one
// operation only. After a send a 409 or a 5xx may follow a created message, so it is unknown.
function failureOf(failure: Failure, now: Date, sent: boolean): ProviderResult {
  const { status, code, headers } = failure;
  const named = code === undefined ? {} : { providerCode: String(code) };
  const shared = headers.get("x-ratelimit-scope") === "shared";
  const answered = (result: ProviderResult): ProviderResult => ({ ...result, httpStatus: status });
  if (status === 429) {
    const delay = delayMs(failure.retryAfter, headers, now);
    return answered(
      errorResult({
        ...NO_EFFECT,
        errorClass: "rate_limited",
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
        ...(shared ? { providerCode: "rate_limit_shared" } : named),
      }),
    );
  }
  const webhookGone = code === UNKNOWN_WEBHOOK || code === INVALID_WEBHOOK_TOKEN;
  if (status === 401 || (status < 500 && webhookGone)) {
    return answered(errorResult({ ...NO_EFFECT, errorClass: "auth_revoked", ...named }));
  }
  if (sent && (status === 409 || status >= 500)) return answered(unknown());
  const errorClass = status >= 500 ? "retryable_before_send" : "permanent";
  return answered(errorResult({ ...NO_EFFECT, errorClass, ...named }));
}

type Reply =
  | { readonly ok: true; readonly status: number; readonly json: unknown }
  | {
      readonly ok: false;
      readonly status: number | undefined;
      readonly code: number | undefined;
      readonly result: ProviderResult;
    };

interface CallInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

/** `sent` is true for a call that changes something, whose lost answer is unknown. */
async function call(
  context: AdapterContext,
  hook: Webhook,
  path: string,
  init: CallInit = {},
  sent = false,
): Promise<Reply> {
  const headers = { "user-agent": USER_AGENT, ...init.headers };
  try {
    const response = await context.fetch(
      `https://${hook.host}/api/webhooks/${hook.id}/${hook.token}${path}`,
      {
        ...init,
        headers,
      },
    );
    const json = await answerJson(response);
    if (response.ok) return { ok: true, status: response.status, json };
    const body = errorBody.safeParse(json).data;
    const failure = {
      status: response.status,
      code: body?.code,
      headers: response.headers,
      retryAfter: body?.retry_after,
    };
    return {
      ok: false,
      status: response.status,
      code: failure.code,
      result: failureOf(failure, context.now(), sent),
    };
  } catch (error) {
    return { ok: false, status: undefined, code: undefined, result: networkFailure(error, sent) };
  }
}

// A webhook of another kind (a channel follower) is not one this product posts through.
const webhookAnswer = z.object({
  id: z.string().regex(SNOWFLAKE),
  type: z.number(),
  name: z.string().max(256).nullable().optional(),
});

type Found =
  | { readonly found: true; readonly id: string; readonly name: string | null }
  | {
      readonly found: false;
      readonly result: ProviderResult;
    };

async function readWebhook(context: AdapterContext, hook: Webhook): Promise<Found> {
  const answer = await call(context, hook, "");
  if (!answer.ok) return { found: false, result: answer.result };
  const parsed = webhookAnswer.safeParse(answer.json);
  if (!parsed.success || parsed.data.id !== hook.id) return { found: false, result: unusable() };
  if (parsed.data.type !== 1) {
    const refused = errorResult({
      ...NO_EFFECT,
      errorClass: "permanent",
      providerCode: "unsupported_webhook",
    });
    return { found: false, result: refused };
  }
  return { found: true, id: parsed.data.id, name: parsed.data.name ?? null };
}

async function verifySecret(context: AdapterContext, input: VerifySecretInput): Promise<ProviderResult> {
  const hook = input.kind === "webhook_url" ? webhookOf(input.secret.expose()) : undefined;
  if (hook === undefined) return refusedInput();
  const read = await readWebhook(context, hook);
  if (!read.found) return read.result;
  return {
    ok: true,
    ...NO_EFFECT,
    identity: {
      providerAccountId: read.id,
      accountKind: "channel",
      displayName: read.name ?? read.id,
    },
  };
}

async function inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult> {
  const hook = webhookOf(input.accessToken.expose());
  if (hook === undefined) return refusedInput();
  const read = await readWebhook(context, hook);
  return read.found ? { ok: true, ...NO_EFFECT, health: "ok" } : read.result;
}

const connect: ConnectAdapter = { verifySecret };

const limitOf = (name: string): number => {
  const value = discordManifest.limits[name]?.value;
  if (value === undefined) throw new Error(`the manifest states no ${name} limit`);
  return value;
};
// https://docs.discord.com/developers/resources/message: an attachment's description is at most 1024 characters.
const MAX_DESCRIPTION = 1024;
// https://docs.discord.com/developers/resources/message: `parse` is exclusive with the other fields, and the webhook
// default is users only. It is stated so a pasted @everyone or role mention never notifies a whole server.
const ALLOWED_MENTIONS = { parse: ["users"] } as const;
// VERIFY: no page read states a file count; ten is Discord's known limit until a live check shows it.
const MAX_FILES = 10;

function mediaRefused(items: readonly MediaItem[]): boolean {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  const long = items.some((item) => item.altText !== null && [...item.altText].length > MAX_DESCRIPTION);
  return (
    long ||
    items.length > MAX_FILES ||
    items.some((item) => item.size > limitOf("imageMaxBytes")) ||
    total > limitOf("requestMaxBytes")
  );
}

// A webhook has no upload step: the files travel with the message. The step the ledger runs per medium only checks the
// whole set before anything is sent and hands back a position the message call reads.
async function prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const media = context.media;
  const done = input.mediaIds?.length ?? 0;
  if (media === undefined || done >= media.items.length) return { ok: true, ...NO_EFFECT };
  if (done === 0 && mediaRefused(media.items)) return refusedInput();
  return { ok: true, ...NO_EFFECT, upload: { mediaId: `file-${done}` } };
}

interface Attachment {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly altText: string | null;
}

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const SAFE_MIME = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;
const fileNameOf = (mime: string, index: number) => `file-${index}.${FILE_EXTENSIONS[mime] ?? "bin"}`;

// multipart/form-data (RFC 7578) as the reference documents it: `payload_json` for the message and `files[n]` per file.
function multipartOf(payload: unknown, files: readonly Attachment[]) {
  const boundary = `shoutory-${globalThis.crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const json = `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`;
  const parts: Uint8Array[] = [encoder.encode(json)];
  for (const [index, file] of files.entries()) {
    const type = SAFE_MIME.test(file.mime) ? file.mime : "application/octet-stream";
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="files[${index}]"; filename="${fileNameOf(file.mime, index)}"\r\nContent-Type: ${type}\r\n\r\n`;
    parts.push(encoder.encode(head), file.bytes, encoder.encode("\r\n"));
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

type Read = { readonly files: readonly Attachment[] } | { readonly result: ProviderResult };

async function filesOf(media: MediaReader | undefined): Promise<Read> {
  if (media === undefined || media.items.length === 0) return { files: [] };
  if (mediaRefused(media.items)) return { result: refusedInput() };
  const files: Attachment[] = [];
  for (const position of media.items.keys()) {
    try {
      const file = await media.read(position);
      if (file.bytes.length > limitOf("imageMaxBytes")) return { result: refusedInput() };
      files.push({ mime: media.items[position]?.mime ?? "", bytes: file.bytes, altText: file.altText });
    } catch (error) {
      if (!(error instanceof MediaReadError)) throw error;
      return {
        result: errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "media_unavailable" }),
      };
    }
  }
  // What was read, not what the items said, is what would be sent.
  const read = files.map(
    (file): MediaItem => ({ mime: file.mime, size: file.bytes.length, altText: file.altText }),
  );
  return mediaRefused(read) ? { result: refusedInput() } : { files };
}

function messageBody(text: string, files: readonly Attachment[]) {
  if (files.length === 0) {
    const body = JSON.stringify({ content: text, allowed_mentions: ALLOWED_MENTIONS });
    return { headers: { "content-type": "application/json" }, body };
  }
  const attachments = files.map((file, index) => ({
    id: index,
    filename: fileNameOf(file.mime, index),
    ...(file.altText === null ? {} : { description: file.altText }),
  }));
  const { body, contentType } = multipartOf(
    { content: text, allowed_mentions: ALLOWED_MENTIONS, attachments },
    files,
  );
  return { headers: { "content-type": contentType }, body };
}

const messageAnswer = z.object({ id: z.string().regex(SNOWFLAKE), content: z.string().max(10_000) });

// `wait=true` makes the answer the created message, whose id is the only handle a later read, edit or delete has.
// A 200 that holds no message may have created one, so it is unknown.
async function commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const hook = webhookOf(input.account?.accessToken.expose() ?? "");
  if (hook === undefined) return refusedInput();
  const read = await filesOf(context.media);
  if ("result" in read) return read.result;
  const answer = await call(
    context,
    hook,
    "?wait=true",
    { method: "POST", ...messageBody(input.text, read.files) },
    true,
  );
  if (!answer.ok) return answer.result;
  const message = messageAnswer.safeParse(answer.json);
  return message.success ? { ok: true, effect: "confirmed", externalId: message.data.id } : unknown();
}

// Discord answers 404 with code 10008 for a message that is not there and 10015 for a webhook that is gone; a 404 with
// any other code proves nothing about either.
const MESSAGE_GONE = 10008;
const isGone = (answer: Extract<Reply, { ok: false }>) =>
  answer.status === 404 && answer.code === MESSAGE_GONE;
const absent = (): ProviderResult => ({
  ...errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: String(MESSAGE_GONE) }),
  absent: true,
  httpStatus: 404,
});

// An id from outside goes into a path: only a snowflake passes, so it cannot name another route or add a query.
function targetOf(post: RemotePost): { readonly hook: Webhook; readonly id: string } | undefined {
  const hook = webhookOf(post.account?.accessToken.expose() ?? "");
  const id = post.externalId;
  return hook !== undefined && id !== undefined && SNOWFLAKE.test(id) ? { hook, id } : undefined;
}

async function readMessage(context: AdapterContext, post: RemotePost) {
  const target = targetOf(post);
  if (target === undefined) return { result: refusedInput() };
  const answer = await call(context, target.hook, `/messages/${target.id}`);
  if (!answer.ok) return { result: isGone(answer) ? absent() : answer.result };
  const message = messageAnswer.safeParse(answer.json);
  if (!message.success || message.data.id !== target.id) return { result: unusable() };
  return { message: message.data };
}

async function readBack(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const read = await readMessage(context, post);
  return read.message ? { ok: true, effect: "confirmed", externalId: read.message.id } : read.result;
}

// The text the message holds now, to compare an edit that may have been applied. A webhook message has no post settings.
async function readSource(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const read = await readMessage(context, post);
  if (!read.message) return read.result;
  return {
    ok: true,
    ...NO_EFFECT,
    externalId: read.message.id,
    content: { text: read.message.content, settings: {} },
  };
}

// VERIFY: only `content` and the mention rule are sent, and the edit docs say files are appended and `attachments` lists
// those to keep, so leaving it out is taken to keep the message's files and embeds; a live check must show it. A 5xx or a cut answer may follow an
// applied edit, and an answer for another message proves nothing, so both are unknown.
async function edit(
  context: AdapterContext,
  post: RemotePost,
  input: Parameters<NonNullable<ProviderAdapter["edit"]>>[2],
): Promise<ProviderResult> {
  const target = targetOf(post);
  if (target === undefined) return refusedInput();
  const init = {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: input.text, allowed_mentions: ALLOWED_MENTIONS }),
  };
  const answer = await call(context, target.hook, `/messages/${target.id}`, init, true);
  if (!answer.ok) return isGone(answer) ? absent() : answer.result;
  const message = messageAnswer.safeParse(answer.json);
  if (!message.success || message.data.id !== target.id) return unknown();
  return { ok: true, effect: "confirmed", externalId: target.id };
}

// A message that is already gone is a removal that needs nothing more.
async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const target = targetOf(post);
  if (target === undefined) return refusedInput();
  const answer = await call(context, target.hook, `/messages/${target.id}`, { method: "DELETE" }, true);
  if (answer.ok) return { ok: true, effect: "confirmed" };
  return isGone(answer) ? { ok: true, ...NO_EFFECT } : answer.result;
}

export const createDiscordAdapter = (): ProviderAdapter => ({
  prepare,
  commit,
  readBack,
  readSource,
  edit,
  delete: remove,
  inspect,
  connect,
});
