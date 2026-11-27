import type { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import { isPolicyRefusal } from "@shoutory/provider-sdk/egress/errors";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";

// Built from https://core.telegram.org/bots/api (read 2026-11-27): every call is a POST to
// https://api.telegram.org/bot<token>/<method>, so the token is a path segment. Nothing here puts a URL, an exception
// message or a description from Telegram into a result: a result carries only the fixed codes below.

export const NO_EFFECT = { effect: "none" } as const;

// An answer that cannot be told from success or failure after a write: the effect may have happened.
export const lost = (): ProviderResult => errorResult({ effect: "possible", errorClass: "unknown" });
const MAX_ANSWER_BYTES = 512 * 1024;
// Failures before a connection exists: the request never left, so a retry cannot double a send.
const NOT_SENT = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** What a lost answer means: a read changes nothing; a write may have, and says how the ledger may go on. */
type Kind = "read" | "unknown" | "retryable_after_send";

export interface Call {
  readonly method: string;
  readonly kind: Kind;
  readonly json?: Readonly<Record<string, unknown>>;
  readonly form?: FormData;
}

export type Reply =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly status: number | undefined;
      readonly phrase: string;
      readonly result: ProviderResult;
    };

const failure = z.object({
  description: z.string().max(1024).catch(""),
  parameters: z
    .object({
      retry_after: z.number().optional().catch(undefined),
      migrate_to_chat_id: z.number().optional().catch(undefined),
    })
    .catch({}),
});

// The phrase after the status text of a documented error, matched case-insensitively against what Telegram sends
// (core.telegram.org/bots/api#making-requests documents the status and the description, not the phrases).
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/chat not found/i, "chat_not_found"],
  [/message is too long/i, "text_too_long"],
  [/caption is too long/i, "caption_too_long"],
  [/text is empty|text must be non-empty/i, "text_empty"],
  [/can't parse entities/i, "bad_entities"],
  [
    /wrong file|failed to get http url|wrong type of the web page content|file is too big|photo_invalid_dimensions|image_process_failed/i,
    "media_refused",
  ],
  [
    /not enough rights|have no rights|write_forbidden|need administrator rights|bot was kicked|bot was blocked|bot is not a member|bot can't|chat_write/i,
    "bot_cannot_post",
  ],
  [/message can't be deleted|message can't be edited/i, "action_refused"],
  [/message to (delete|edit) not found|message_id_invalid/i, "message_gone"],
  [/message is not modified/i, "not_modified"],
];

const phraseOf = (description: string): string =>
  PHRASES.find(([pattern]) => pattern.test(description))?.[1] ?? "";

const unknownAfterSend = (kind: Kind): ProviderResult =>
  kind === "read"
    ? errorResult({ ...NO_EFFECT, errorClass: "unknown" })
    : errorResult({ effect: "possible", errorClass: kind });

const CUT_OFF = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);

// Every failure of the network is a result: an exception message may name the URL, and the URL holds the token.
function networkFailure(error: unknown, kind: Kind): ProviderResult {
  if (isPolicyRefusal(error))
    return errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: "address_not_allowed" });
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  if (typeof code === "string" && NOT_SENT.has(code))
    return errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" });
  const deadline = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (deadline || (typeof code === "string" && CUT_OFF.has(code)) || kind !== "read")
    return unknownAfterSend(kind);
  return errorResult({ ...NO_EFFECT, errorClass: "unknown" });
}

// `Retry-After` is a generic header a proxy may add; Telegram's own answer is `parameters.retry_after`, in seconds
// (ResponseParameters, core.telegram.org/bots/api, read 2026-11-27).
function retryDelayMs(headers: Headers, now: Date, seconds: number | undefined): number | undefined {
  if (seconds !== undefined) return Math.round(seconds * 1000);
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  if (/^\d+$/.test(after)) return Number(after) * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

function failureOf(response: Response, body: unknown, kind: Kind, now: Date): [ProviderResult, string] {
  const parsed = failure.safeParse(body);
  const { description, parameters } = parsed.success ? parsed.data : { description: "", parameters: {} };
  const phrase = phraseOf(description);
  const { status } = response;
  const base = { httpStatus: status };
  if (status === 429) {
    const delay = retryDelayMs(response.headers, now, parameters.retry_after);
    const limited = errorResult({
      ...NO_EFFECT,
      errorClass: "rate_limited",
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
    return [{ ...limited, ...base }, phrase];
  }
  if (status === 401)
    return [
      {
        ...errorResult({ ...NO_EFFECT, errorClass: "auth_revoked", providerCode: "token_revoked" }),
        ...base,
      },
      phrase,
    ];
  if (kind !== "read" && (status === 409 || status >= 500))
    return [{ ...unknownAfterSend(kind), ...base }, phrase];
  if (status >= 500) return [errorResult({ ...NO_EFFECT, errorClass: "retryable_before_send" }), phrase];
  const code = parameters.migrate_to_chat_id !== undefined ? "chat_migrated" : phrase || `http_${status}`;
  return [{ ...errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode: code }), ...base }, phrase];
}

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

const success = z.object({ ok: z.literal(true), result: z.unknown() });

const botSchema = z.object({
  id: z.int(),
  username: z.string().max(64).optional(),
  first_name: z.string().max(256).catch(""),
});

export type Bot = z.infer<typeof botSchema>;

export type Found<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false; readonly result: ProviderResult };

const memberSchema = z.object({
  status: z.string().max(32),
  can_post_messages: z.boolean().optional(),
  can_send_messages: z.boolean().optional(),
  is_member: z.boolean().optional(),
});

type Member = z.infer<typeof memberSchema>;

// `can_post_messages` is only stated for a channel administrator (ChatMemberAdministrator, core.telegram.org/bots/api,
// read 2026-11-27); a chat of unknown type is judged by what the member states.
function mayPost(member: Member, chatType: string | undefined): boolean {
  switch (member.status) {
    case "creator":
      return true;
    case "administrator":
      return chatType === "channel" ? member.can_post_messages === true : member.can_post_messages !== false;
    case "member":
      return chatType !== "channel";
    case "restricted":
      return member.is_member === true && member.can_send_messages === true;
    default:
      return false;
  }
}

/** Whether the bot may write in the chat; a chat the bot is gone from or refused is answered `false`, not a failure. */
export async function mayPostIn(
  context: AdapterContext,
  token: SealedSecret,
  input: { readonly botId: number; readonly chatId: string; readonly chatType?: string },
): Promise<Found<boolean>> {
  const reply = await callApi(context, token, {
    method: "getChatMember",
    kind: "read",
    json: { chat_id: input.chatId, user_id: input.botId },
  });
  if (!reply.ok) {
    if (reply.status === 400 || reply.status === 403) return { found: true, value: false };
    return { found: false, result: reply.result };
  }
  const member = memberSchema.safeParse(reply.result);
  if (!member.success) return { found: false, result: errorResult({ ...NO_EFFECT, errorClass: "unknown" }) };
  return { found: true, value: mayPost(member.data, input.chatType) };
}

/** `getMe`: the bot a token belongs to. A token Telegram refuses is a revoked one. */
export async function getMe(context: AdapterContext, token: SealedSecret): Promise<Found<Bot>> {
  const reply = await callApi(context, token, { method: "getMe", kind: "read" });
  if (!reply.ok) return { found: false, result: reply.result };
  const bot = botSchema.safeParse(reply.result);
  if (!bot.success) return { found: false, result: errorResult({ ...NO_EFFECT, errorClass: "unknown" }) };
  return { found: true, value: bot.data };
}

export async function callApi(context: AdapterContext, token: SealedSecret, call: Call): Promise<Reply> {
  const url = `https://api.telegram.org/bot${token.expose()}/${call.method}`;
  const init: RequestInit =
    call.form === undefined
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(call.json ?? {}),
        }
      : { method: "POST", body: call.form };
  try {
    const response = await context.fetch(url, init);
    const body = await answerJson(response);
    if (!response.ok) {
      const [result, phrase] = failureOf(response, body, call.kind, context.now());
      return { ok: false, status: response.status, phrase, result };
    }
    const parsed = success.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: response.status, phrase: "", result: unknownAfterSend(call.kind) };
    }
    return { ok: true, result: parsed.data.result };
  } catch (error) {
    return { ok: false, status: undefined, phrase: "", result: networkFailure(error, call.kind) };
  }
}
