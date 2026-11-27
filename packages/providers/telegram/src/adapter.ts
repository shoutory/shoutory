import { countText } from "@shoutory/core/counting";
import type { SealedSecret } from "@shoutory/core/crypto";
import {
  type AccountAccess,
  type AdapterContext,
  type CommitInput,
  type ConnectAdapter,
  type InspectInput,
  type MediaItem,
  MediaReadError,
  type ProviderAdapter,
  type RemotePost,
  type VerifySecretInput,
} from "@shoutory/provider-sdk/adapter";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { type Call, callApi, type Found, getMe, lost, mayPostIn, NO_EFFECT, type Reply } from "./api.js";
import { telegramManifest } from "./manifest.js";
import { pollChallenge } from "./updates.js";

// Built from https://core.telegram.org/bots/api (sendMessage, sendPhoto, sendMediaGroup, editMessageText,
// editMessageCaption, deleteMessage, deleteMessages, getChatMember, getMe, getWebhookInfo; read 2026-11-27). A send has
// no id to look for afterwards, so a lost answer is an unknown outcome and the ledger never sends it again.

const refusal = (providerCode: string): ProviderResult =>
  errorResult({ ...NO_EFFECT, errorClass: "permanent", providerCode });

const limitOf = (name: string): number => {
  const limit = telegramManifest.limits[name];
  if (limit === undefined) throw new Error(`the manifest states no ${name}`);
  return limit.value;
};

// VERIFY: the page does not list the image types sendPhoto takes; these are the ones it shows in its examples.
const PHOTO_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Parse mode HTML needs only `<`, `>` and `&` replaced (core.telegram.org/bots/api#html-style); the person's text is
// text, never markup, so it is escaped here and nowhere else.
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Target {
  readonly token: SealedSecret;
  readonly chatId: string;
}

function targetOf(account: AccountAccess | undefined): Target {
  if (account?.providerAccountId === undefined) throw new Error("a Telegram call needs the bot and the chat");
  return { token: account.accessToken, chatId: account.providerAccountId };
}

// A message is `t:` text, `p:` one photo or `a:` an album; an album holds the id of every message it made, because
// deleting it takes them all. The format is this adapter's own.
const EXTERNAL_ID = /^([tpa]):(\d+(?:,\d+)*)$/;

function parseId(externalId: string | undefined): { kind: string; ids: number[] } | undefined {
  const found = externalId === undefined ? null : EXTERNAL_ID.exec(externalId);
  if (found === null) return undefined;
  return { kind: found[1] ?? "", ids: (found[2] ?? "").split(",").map(Number) };
}

function textProblem(text: string, withMedia: boolean): ProviderResult | undefined {
  const length = countText(telegramManifest.counting, text);
  if (withMedia) return length > limitOf("captionLength") ? refusal("caption_too_long") : undefined;
  if (text.trim() === "") return refusal("text_empty");
  return length > limitOf("textLength") ? refusal("text_too_long") : undefined;
}

function mediaProblem(items: readonly MediaItem[]): ProviderResult | undefined {
  if (items.length > limitOf("mediaMaxCount")) return refusal("too_many_media");
  if (items.some((item) => PHOTO_TYPES[item.mime] === undefined)) return refusal("media_unsupported");
  if (items.some((item) => item.size > limitOf("imageMaxBytes"))) return refusal("media_too_large");
  return undefined;
}

// Nothing is uploaded here: Telegram takes a file only inside the send, as multipart. This step answers for each
// medium so a file Telegram would refuse is stopped before anything is sent.
async function prepare(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const items = context.media?.items ?? [];
  const refused = textProblem(input.text, items.length > 0) ?? mediaProblem(items);
  if (refused) return refused;
  const position = input.mediaIds?.length ?? 0;
  if (position >= items.length) return { ok: true, ...NO_EFFECT };
  return { ok: true, ...NO_EFFECT, upload: { mediaId: String(position) } };
}

const messageSchema = z.object({ message_id: z.int() });
const albumSchema = z.array(messageSchema).min(2).max(10);

// An album answers one message per file; any other count leaves a message nobody holds the id of.
function sent(reply: Reply, kind: "t" | "p" | "a", files = 1): ProviderResult {
  if (!reply.ok) return reply.result;
  const parsed =
    kind === "a"
      ? albumSchema.safeParse(reply.result)
      : messageSchema.transform((message) => [message]).safeParse(reply.result);
  if (!parsed.success || parsed.data.length !== files) return lost();
  if (parsed.data.some((message) => message.message_id <= 0)) return lost();
  const ids = parsed.data.map((message) => message.message_id).join(",");
  return { ok: true, effect: "confirmed", externalId: `${kind}:${ids}` };
}

async function readMedia(context: AdapterContext, input: CommitInput): Promise<FormData | ProviderResult> {
  const media = context.media;
  if (media === undefined) throw new Error("a post with media needs the media reader");
  const wanted = (input.mediaIds ?? media.items.map((_item, index) => String(index))).map(Number);
  const form = new FormData();
  try {
    for (const [index, position] of wanted.entries()) {
      const file = await media.read(position);
      const mime = media.items[position]?.mime ?? "";
      form.append(
        `file${index}`,
        new Blob([new Uint8Array(file.bytes)], { type: mime }),
        `file${index}.${PHOTO_TYPES[mime]}`,
      );
    }
  } catch (error) {
    if (error instanceof MediaReadError) return refusal("media_unreadable");
    throw error;
  }
  return form;
}

async function commit(context: AdapterContext, input: CommitInput): Promise<ProviderResult> {
  const { token, chatId } = targetOf(input.account);
  const items = context.media?.items ?? [];
  const refused = textProblem(input.text, items.length > 0) ?? mediaProblem(items);
  if (refused) return refused;
  const text = escapeHtml(input.text);
  if (items.length === 0) {
    const call: Call = {
      method: "sendMessage",
      kind: "unknown",
      json: { chat_id: chatId, text, parse_mode: "HTML" },
    };
    return sent(await callApi(context, token, call), "t");
  }
  const form = await readMedia(context, input);
  if (!(form instanceof FormData)) return form;
  form.append("chat_id", chatId);
  const album = items.length > 1;
  if (!album) {
    form.append("photo", form.get("file0") as Blob);
    form.delete("file0");
    if (text !== "") form.append("caption", text);
    form.append("parse_mode", "HTML");
    return sent(await callApi(context, token, { method: "sendPhoto", kind: "unknown", form }), "p");
  }
  const group = items.map((_item, index) => ({
    type: "photo",
    media: `attach://file${index}`,
    ...(index === 0 && text !== "" ? { caption: text, parse_mode: "HTML" } : {}),
  }));
  form.append("media", JSON.stringify(group));
  const reply = await callApi(context, token, { method: "sendMediaGroup", kind: "unknown", form });
  return sent(reply, "a", items.length);
}

// A repeated edit or delete is harmless and no read exists, so both say how a lost answer may be retried.
async function edit(
  context: AdapterContext,
  post: RemotePost,
  input: { readonly text: string },
): Promise<ProviderResult> {
  const { token, chatId } = targetOf(post.account);
  const parsed = parseId(post.externalId);
  if (parsed === undefined) return refusal("bad_external_id");
  const withMedia = parsed.kind !== "t";
  const refused = withMedia && input.text === "" ? undefined : textProblem(input.text, withMedia);
  if (refused) return refused;
  const text = escapeHtml(input.text);
  const body = { chat_id: chatId, message_id: parsed.ids[0], parse_mode: "HTML" };
  const call: Call = withMedia
    ? { method: "editMessageCaption", kind: "retryable_after_send", json: { ...body, caption: text } }
    : { method: "editMessageText", kind: "retryable_after_send", json: { ...body, text } };
  const reply = await callApi(context, token, call);
  // Telegram refuses an edit that changes nothing; the post already reads as wanted.
  if (reply.ok || reply.phrase === "not_modified") {
    return { ok: true, effect: "confirmed", externalId: post.externalId as string };
  }
  return reply.result;
}

async function remove(context: AdapterContext, post: RemotePost): Promise<ProviderResult> {
  const { token, chatId } = targetOf(post.account);
  const parsed = parseId(post.externalId);
  if (parsed === undefined) return refusal("bad_external_id");
  // One call per message: `deleteMessages` skips what it cannot find and still answers true, so it proves nothing about
  // an album (core.telegram.org/bots/api#deletemessages, read 2026-11-27). A message already gone is what a delete
  // wants; the first refusal ends the delete and is its answer, and a repeat starts over harmlessly.
  let deleted = 0;
  for (const id of parsed.ids) {
    const reply = await callApi(context, token, {
      method: "deleteMessage",
      kind: "retryable_after_send",
      json: { chat_id: chatId, message_id: id },
    });
    if (reply.ok) deleted += 1;
    else if (reply.phrase !== "message_gone") return reply.result;
  }
  return deleted > 0 ? { ok: true, effect: "confirmed" } : { ok: true, ...NO_EFFECT };
}

const webhookInfo = z.object({ url: z.string().max(2048).catch("") });

// `getUpdates` fails while a webhook is set (core.telegram.org/bots/api#getupdates, read 2026-11-27), and a webhook
// is something the person set elsewhere: the bot is refused rather than its webhook removed.
async function verifySecret(context: AdapterContext, input: VerifySecretInput): Promise<ProviderResult> {
  if (input.kind !== "bot_token") return refusal("wrong_secret_kind");
  const bot = await getMe(context, input.secret);
  if (!bot.found) return bot.result;
  const info = await callApi(context, input.secret, { method: "getWebhookInfo", kind: "read" });
  if (!info.ok) return info.result;
  const webhook = webhookInfo.safeParse(info.result);
  if (!webhook.success) return errorResult({ ...NO_EFFECT, errorClass: "unknown" });
  if (webhook.data.url !== "") return refusal("webhook_set");
  const { id, username, first_name: name } = bot.value;
  return {
    ok: true,
    ...NO_EFFECT,
    identity: {
      providerAccountId: String(id),
      accountKind: "bot",
      displayName: name === "" ? (username ?? String(id)) : name,
      ...(username === undefined ? {} : { handle: username }),
    },
  };
}

const chatSchema = z.object({ type: z.string().max(32) });

// A plain member may post in a group but not in a channel, so the chat's type decides. A chat the bot can no longer
// read at all (removed, deleted) has no type: `undefined`, which the caller reads as lost rights.
async function chatTypeOf(
  context: AdapterContext,
  token: SealedSecret,
  chatId: string,
): Promise<Found<string | undefined>> {
  const reply = await callApi(context, token, { method: "getChat", kind: "read", json: { chat_id: chatId } });
  if (!reply.ok) {
    if (reply.status === 400 || reply.status === 403) return { found: true, value: undefined };
    return { found: false, result: reply.result };
  }
  const chat = chatSchema.safeParse(reply.result);
  if (!chat.success) return { found: false, result: errorResult({ ...NO_EFFECT, errorClass: "unknown" }) };
  return { found: true, value: chat.data.type };
}

// The bot's own membership says whether it can still write: losing the right limits the channel, it does not end it.
async function inspect(context: AdapterContext, input: InspectInput): Promise<ProviderResult> {
  const { token, chatId } = targetOf({
    accessToken: input.accessToken,
    ...(input.providerAccountId === undefined ? {} : { providerAccountId: input.providerAccountId }),
  });
  const bot = await getMe(context, token);
  if (!bot.found) return bot.result;
  const chat = await chatTypeOf(context, token, chatId);
  if (!chat.found) return chat.result;
  if (chat.value === undefined) return { ok: true, ...NO_EFFECT, health: "degraded" };
  const may = await mayPostIn(context, token, { botId: bot.value.id, chatId, chatType: chat.value });
  if (!may.found) return may.result;
  return { ok: true, ...NO_EFFECT, health: may.value ? "ok" : "degraded" };
}

const readBack = async (): Promise<ProviderResult> => refusal("no_read_back");

const connect: ConnectAdapter = { verifySecret, pollChallenge };

export const createTelegramAdapter = (): ProviderAdapter => ({
  prepare,
  commit,
  readBack,
  edit,
  delete: remove,
  inspect,
  connect,
});
