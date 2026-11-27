import type { AdapterContext, PollChallengeInput } from "@shoutory/provider-sdk/adapter";
import { errorResult, type ProviderResult } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import { callApi, type Found, getMe, mayPostIn } from "./api.js";

// `getUpdates` is long polling that confirms every update below `offset`; it fails while a webhook is set, and updates
// are kept for 24 hours (core.telegram.org/bots/api#getupdates, read 2026-11-27). The offset belongs to the bot and is
// stored by the caller, so a poll only reads and says where to go on.

const MAX_UPDATES = 100;
const MAX_TITLE = 128;
// The word the person types, as the wizard shows it: `/connect word`, or `/connect@bot word` in a group.
const CONNECT = /^\/connect(?:@(\w+))?\s+(\S+)/;

const chatSchema = z.object({
  id: z.int(),
  type: z.string().max(32).optional(),
  title: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  first_name: z.string().max(256).optional(),
});
const postSchema = z.object({ text: z.string().max(4096).optional(), chat: chatSchema });
// Each update is parsed on its own: one that does not parse is skipped, never allowed to hold the others back, and the
// offset still moves past it (it moves by the raw ids), so a poisoned update cannot stall the connect.
const updateIdSchema = z.object({ update_id: z.int().nonnegative() });
const updateSchema = updateIdSchema.extend({
  message: postSchema.optional(),
  channel_post: postSchema.optional(),
});
const rawUpdatesSchema = z.array(z.unknown()).max(MAX_UPDATES);
type Update = z.infer<typeof updateSchema>;

type Chat = z.infer<typeof chatSchema>;

const titleOf = (chat: Chat): string =>
  (chat.title ?? chat.username ?? chat.first_name ?? String(chat.id)).slice(0, MAX_TITLE);

const conflict = (): ProviderResult =>
  errorResult({ effect: "none", errorClass: "permanent", providerCode: "poll_conflict" });

type Post = z.infer<typeof postSchema>;

interface Word {
  readonly text: string;
  readonly word: string;
  readonly chat: Chat;
}

// A `/connect word` post addressed to this bot, or to no bot in particular.
function wordIn(post: Post | undefined, bot: { readonly username?: string | undefined }): Word | undefined {
  const found = post?.text === undefined ? null : CONNECT.exec(post.text);
  const [, addressed, word] = found ?? [];
  if (post?.text === undefined || word === undefined) return undefined;
  if (addressed !== undefined && addressed.toLowerCase() !== bot.username?.toLowerCase()) return undefined;
  return { text: post.text, word, chat: post.chat };
}

export async function pollChallenge(
  context: AdapterContext,
  input: PollChallengeInput,
): Promise<ProviderResult> {
  const bot = await getMe(context, input.botToken);
  if (!bot.found) return bot.result;
  const reply = await callApi(context, input.botToken, {
    method: "getUpdates",
    kind: "read",
    json: {
      offset: input.offset,
      limit: MAX_UPDATES,
      timeout: 0,
      allowed_updates: ["message", "channel_post"],
    },
  });
  if (!reply.ok) return reply.status === 409 ? conflict() : reply.result;
  const raw = rawUpdatesSchema.safeParse(reply.result);
  if (!raw.success) return errorResult({ effect: "none", errorClass: "unknown" });
  const updates = raw.data.flatMap((item) => {
    const parsed = updateSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const sorted = await sortWords(context, input.botToken, bot.value, updates);
  if (!sorted.found) return sorted.result;
  const highest = raw.data.reduce<number>((top, item) => {
    const id = updateIdSchema.safeParse(item);
    return id.success ? Math.max(top, id.data.update_id) : top;
  }, input.offset - 1);
  const poll = { nextOffset: highest + 1, ...sorted.value };
  return { ok: true, effect: "none", poll };
}

interface Sorted {
  readonly messages: { text: string; chatId: string; title: string }[];
  readonly held: { word: string; reason: "bot_cannot_post" }[];
}

// Each chat's rights are asked once per poll; a word from a chat the bot may not write in is held, not dropped.
async function sortWords(
  context: AdapterContext,
  token: PollChallengeInput["botToken"],
  bot: { readonly id: number; readonly username?: string | undefined },
  updates: readonly Update[],
): Promise<Found<Sorted>> {
  const sorted: Sorted = { messages: [], held: [] };
  const rights = new Map<number, boolean>();
  for (const update of updates) {
    const found = wordIn(update.message ?? update.channel_post, bot);
    if (found === undefined) continue;
    const { chat } = found;
    let allowed = rights.get(chat.id);
    if (allowed === undefined) {
      const checked = await mayPostIn(context, token, {
        botId: bot.id,
        chatId: String(chat.id),
        ...(chat.type === undefined ? {} : { chatType: chat.type }),
      });
      if (!checked.found) return checked;
      allowed = checked.value;
      rights.set(chat.id, allowed);
    }
    if (allowed) sorted.messages.push({ text: found.text, chatId: String(chat.id), title: titleOf(chat) });
    else sorted.held.push({ word: found.word, reason: "bot_cannot_post" });
  }
  return { found: true, value: sorted };
}
