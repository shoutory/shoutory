import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import { describe, expect, it } from "vitest";
import { createTelegramAdapter } from "./adapter.js";

const TOKEN = "777000:updates-bot-token-1";
const now = () => new Date("2026-11-27T00:00:00Z");

const contextFor = (answers: Readonly<Record<string, Response>>): AdapterContext => ({
  now,
  fetch: async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const answer = answers[url.slice(url.lastIndexOf("/") + 1)];
    if (answer === undefined) throw new Error(`no answer armed for ${url.slice(url.lastIndexOf("/") + 1)}`);
    return answer.clone();
  },
});

const ok = (result: unknown) => Response.json({ ok: true, result });
const poll = (offset: number) => ({ botToken: new SealedSecret(TOKEN), offset });
const BOT = ok({ id: 42, username: "shoutory_bot", first_name: "Shoutory" });

const channelPost = (id: number, text: string) => ({
  update_id: id,
  channel_post: { text, chat: { id: -1001, type: "channel", title: "News" } },
});
const groupMessage = (id: number, text: string) => ({
  update_id: id,
  message: { text, chat: { id: -1002, type: "supergroup", title: "Team" } },
});

describe("reading the updates of a bot for a connect word", () => {
  it.each([
    [
      "the word in a channel post",
      [channelPost(10, "/connect word23")],
      { status: "administrator", can_post_messages: true },
      { messages: [{ text: "/connect word23", chatId: "-1001", title: "News" }], held: [] },
    ],
    [
      "/connect@bot in a group",
      [groupMessage(10, "/connect@shoutory_bot word23")],
      { status: "member" },
      { messages: [{ text: "/connect@shoutory_bot word23", chatId: "-1002", title: "Team" }], held: [] },
    ],
    [
      "a command for another bot is not ours",
      [groupMessage(10, "/connect@other_bot word23")],
      { status: "member" },
      { messages: [], held: [] },
    ],
    [
      "a word from a channel where the bot cannot post is held",
      [channelPost(10, "/connect word23")],
      { status: "administrator", can_post_messages: false },
      { messages: [], held: [{ word: "word23", reason: "bot_cannot_post" }] },
    ],
    [
      "a word from a chat the bot was removed from is held",
      [groupMessage(10, "/connect word23")],
      { status: "kicked" },
      { messages: [], held: [{ word: "word23", reason: "bot_cannot_post" }] },
    ],
  ])("%s", async (_name, updates, member, expected) => {
    const context = contextFor({ getMe: BOT, getUpdates: ok(updates), getChatMember: ok(member) });
    const result = await createTelegramAdapter().connect?.pollChallenge?.(context, poll(5));
    expect(result?.poll).toMatchObject({ ...expected, nextOffset: 11 });
    expect(result?.poll?.held).toEqual(expected.held);
  });
});

describe("where the offset goes after a poll", () => {
  it("the next offset is one above the highest update, even for updates that are not a word", async () => {
    const context = contextFor({
      getMe: BOT,
      getUpdates: ok([groupMessage(31, "hello"), groupMessage(30, "again")]),
    });
    const result = await createTelegramAdapter().connect?.pollChallenge?.(context, poll(5));
    expect(result?.poll).toMatchObject({ nextOffset: 32, messages: [], held: [] });
  });

  it("an update that does not parse is skipped, the good ones around it are read and the offset passes it", async () => {
    const bad = { update_id: 31, message: { text: 5, chat: "not a chat" } };
    const context = contextFor({
      getMe: BOT,
      getUpdates: ok([channelPost(30, "/connect word23"), bad, channelPost(32, "/connect other45")]),
      getChatMember: ok({ status: "administrator", can_post_messages: true }),
    });
    const result = await createTelegramAdapter().connect?.pollChallenge?.(context, poll(5));
    expect(result?.poll?.messages.map((message) => message.text)).toEqual([
      "/connect word23",
      "/connect other45",
    ]);
    expect(result?.poll?.nextOffset).toBe(33);
  });

  it("with no update the offset stays where it was", async () => {
    const context = contextFor({ getMe: BOT, getUpdates: ok([]) });
    const result = await createTelegramAdapter().connect?.pollChallenge?.(context, poll(5));
    expect(result?.poll).toMatchObject({ nextOffset: 5 });
  });

  it("a 409 from getUpdates answers a fixed reason and gives no offset to move", async () => {
    const context = contextFor({
      getMe: BOT,
      getUpdates: Response.json(
        {
          ok: false,
          error_code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        },
        { status: 409 },
      ),
    });
    const result = await createTelegramAdapter().connect?.pollChallenge?.(context, poll(5));
    expect(result).toMatchObject({ ok: false, effect: "none", providerCode: "poll_conflict" });
    expect(result?.poll).toBeUndefined();
  });
});
