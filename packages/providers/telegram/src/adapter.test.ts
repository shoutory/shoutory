import { SealedSecret } from "@shoutory/core/crypto";
import type { AdapterContext } from "@shoutory/provider-sdk/adapter";
import { describe, expect, it } from "vitest";
import { createTelegramAdapter } from "./adapter.js";

const TOKEN = '777000:canary-bot-token"1';
const CHAT = "-1001234567890";
const account = { accessToken: new SealedSecret(TOKEN), providerAccountId: CHAT };
const now = () => new Date("2026-11-27T00:00:00Z");

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Answer = Response | Error;

// The bot token is a path segment, so a fake that routes by method name sees exactly what the egress client would log.
// A list of answers is played in order, one per call.
function fake(answers: Readonly<Record<string, Answer | Answer[]>>): {
  context: AdapterContext;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(answers).map(([method, one]) => [method, [one].flat()]));
  const send: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const text = typeof init?.body === "string" ? init.body : null;
    calls.push({ method, url, body: text === null ? init?.body : JSON.parse(text) });
    const answer = queues.get(method)?.shift();
    if (answer === undefined) throw new Error(`no answer armed for ${method}`);
    if (answer instanceof Error) throw answer;
    return answer.clone();
  };
  return { context: { fetch: send, now }, calls };
}

const ok = (result: unknown) => Response.json({ ok: true, result });
const refusal = (status: number, description: string, parameters?: unknown) =>
  Response.json({ ok: false, error_code: status, description, parameters }, { status });

const forms = (secret: string): string[] => [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString("hex"),
  Buffer.from(secret).toString("base64"),
  JSON.stringify(secret).slice(1, -1),
];

describe("the bot token never leaves the adapter in an answer", () => {
  const leaking = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const adapter = createTelegramAdapter();
  const send = (context: AdapterContext) =>
    adapter.commit(context, { idempotencyKey: "canary-1", text: "hello", account });
  const verify = (context: AdapterContext) =>
    adapter.connect?.verifySecret?.(context, { kind: "bot_token", secret: new SealedSecret(TOKEN) });
  const poll = (context: AdapterContext) =>
    adapter.connect?.pollChallenge?.(context, { botToken: new SealedSecret(TOKEN), offset: 3 });
  const inspect = (context: AdapterContext) =>
    adapter.inspect(context, { accessToken: new SealedSecret(TOKEN), providerAccountId: CHAT });
  const bot = ok({ id: 42, username: "shoutory_bot" });
  it.each([
    ["a network error that names the URL", send, { sendMessage: new Error(`fetch failed ${leaking}`) }],
    [
      "a 5xx whose body repeats the URL",
      send,
      { sendMessage: new Response(`bad gateway for ${leaking}`, { status: 502 }) },
    ],
    [
      "a refusal whose description repeats the token",
      send,
      { sendMessage: refusal(400, `Bad Request: ${TOKEN} is not valid`) },
    ],
    ["a revoked token", send, { sendMessage: refusal(401, "Unauthorized") }],
    ["a thrown error from verifying the secret", verify, { getMe: new Error(`fetch failed ${leaking}`) }],
    [
      "a poll whose getUpdates fails with the URL",
      poll,
      { getMe: bot, getUpdates: new Error(`fetch failed ${leaking}`) },
    ],
    [
      "a poll whose getUpdates is refused with the token in the text",
      poll,
      { getMe: bot, getUpdates: refusal(400, `Bad Request: ${TOKEN}`) },
    ],
    [
      "an inspect whose getChatMember fails with the URL",
      inspect,
      { getMe: bot, getChat: ok({ type: "channel" }), getChatMember: new Error(`fetch failed ${leaking}`) },
    ],
    [
      "an inspect whose getChat answers a 5xx repeating the URL",
      inspect,
      { getMe: bot, getChat: new Response(`bad gateway for ${leaking}`, { status: 502 }) },
    ],
  ])("%s", async (_name, run, answers) => {
    const { context } = fake(answers);
    const shown = JSON.stringify(await run(context));
    for (const form of forms(TOKEN)) expect(shown).not.toContain(form);
  });
});

describe("a send that may have been taken is an unknown outcome", () => {
  it.each([
    ["message id 0", () => ok({ message_id: 0, chat: { id: -1 }, date: 1 })],
    ["a 5xx", () => new Response("upstream error", { status: 502 })],
    ["an answer cut off mid-body", () => new Response('{"ok":true,"result":{"message_', { status: 200 })],
    ["a network error after the request left", () => new Error("socket hang up")],
  ])("%s", async (_name, answer) => {
    const { context, calls } = fake({ sendMessage: answer() });
    const result = await createTelegramAdapter().commit(context, {
      idempotencyKey: "unknown-1",
      text: "hello",
      account,
    });
    expect(result).toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
    expect(result.externalId).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("connecting a bot answers a fixed reason", () => {
  it.each([
    [
      "a webhook is set",
      {
        getMe: ok({ id: 1, username: "shoutory_bot" }),
        getWebhookInfo: ok({ url: "https://x.example/hook" }),
      },
      "webhook_set",
    ],
    ["the token is revoked", { getMe: refusal(401, "Unauthorized") }, "token_revoked"],
  ] as const)("%s", async (_name, answers, code) => {
    const { context } = fake({ ...answers });
    const result = await createTelegramAdapter().connect?.verifySecret?.(context, {
      kind: "bot_token",
      secret: new SealedSecret(TOKEN),
    });
    expect(result).toMatchObject({ ok: false, effect: "none", providerCode: code });
  });
});

describe("the text reaches Telegram as escaped HTML", () => {
  it.each([
    ["bare angle brackets and ampersand", "a < b && c > d", "a &lt; b &amp;&amp; c &gt; d"],
    ["a tag-looking word", "use <script> here", "use &lt;script&gt; here"],
    ["an existing entity is escaped again", "fish &amp; chips", "fish &amp;amp; chips"],
  ])("%s", async (_name, text, sent) => {
    const { context, calls } = fake({ sendMessage: ok({ message_id: 7, chat: { id: -1 }, date: 1 }) });
    const result = await createTelegramAdapter().commit(context, { idempotencyKey: "html-1", text, account });
    expect(result).toMatchObject({ ok: true, effect: "confirmed", externalId: "t:7" });
    expect(calls[0]?.body).toMatchObject({ chat_id: CHAT, text: sent, parse_mode: "HTML" });
  });
});

describe("an error maps by its status and the phrase Telegram documents", () => {
  it.each([
    [400, "Bad Request: not enough rights to send text messages to the chat", "permanent", "bot_cannot_post"],
    [403, "Forbidden: bot was kicked from the channel chat", "permanent", "bot_cannot_post"],
    [400, "Bad Request: chat not found", "permanent", "chat_not_found"],
    [400, "Bad Request: message is too long", "permanent", "text_too_long"],
    [400, "Bad Request: can't parse entities: unexpected end tag", "permanent", "bad_entities"],
    [400, "Bad Request: file is too big", "permanent", "media_refused"],
    [400, "Bad Request: PHOTO_INVALID_DIMENSIONS", "permanent", "media_refused"],
    [400, "Bad Request: IMAGE_PROCESS_FAILED", "permanent", "media_refused"],
    [400, "Bad Request: something new", "permanent", "http_400"],
    [401, "Unauthorized", "auth_revoked", "token_revoked"],
  ])("%i %s", async (status, description, errorClass, providerCode) => {
    const { context } = fake({ sendMessage: refusal(status, description) });
    const result = await createTelegramAdapter().commit(context, {
      idempotencyKey: "map-1",
      text: "hi",
      account,
    });
    expect(result).toMatchObject({ ok: false, effect: "none", errorClass, providerCode });
  });

  it.each(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
    "a %s connect failure sent nothing and may be retried",
    async (code) => {
      const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("lookup"), { code }) });
      const { context } = fake({ sendMessage: failure });
      const result = await createTelegramAdapter().commit(context, {
        idempotencyKey: "net-1",
        text: "hi",
        account,
      });
      expect(result).toMatchObject({ ok: false, effect: "none", errorClass: "retryable_before_send" });
    },
  );

  it("a 429 carries the seconds Telegram asks to wait", async () => {
    const { context } = fake({
      sendMessage: refusal(429, "Too Many Requests: retry after 12", { retry_after: 12 }),
    });
    const result = await createTelegramAdapter().commit(context, {
      idempotencyKey: "map-2",
      text: "hi",
      account,
    });
    expect(result).toMatchObject({
      ok: false,
      effect: "none",
      errorClass: "rate_limited",
      retryAfterMs: 12_000,
    });
  });
});

const photo = { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
const mediaOf = (
  count: number,
  mime = photo.mime,
  size = photo.bytes.length,
): NonNullable<AdapterContext["media"]> => ({
  items: Array.from({ length: count }, () => ({ mime, size, altText: null })),
  read: async () => ({ bytes: photo.bytes, altText: null }),
});

describe("images and albums", () => {
  it("one image goes as a multipart photo with the escaped text as its caption", async () => {
    const { context, calls } = fake({ sendPhoto: ok({ message_id: 9 }) });
    const result = await createTelegramAdapter().commit(
      { ...context, media: mediaOf(1) },
      { idempotencyKey: "photo-1", text: "a < b", account, mediaIds: ["0"] },
    );
    expect(result).toMatchObject({ ok: true, externalId: "p:9" });
    const form = calls[0]?.body as FormData;
    expect([form.get("chat_id"), form.get("caption"), form.get("parse_mode")]).toEqual([
      CHAT,
      "a &lt; b",
      "HTML",
    ]);
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("an album keeps the id of every message and the caption sits on the first", async () => {
    const { context, calls } = fake({
      sendMediaGroup: ok([{ message_id: 11 }, { message_id: 12 }, { message_id: 13 }]),
    });
    const result = await createTelegramAdapter().commit(
      { ...context, media: mediaOf(3) },
      { idempotencyKey: "album-1", text: "caption", account, mediaIds: ["0", "1", "2"] },
    );
    expect(result).toMatchObject({ ok: true, externalId: "a:11,12,13" });
    const form = calls[0]?.body as FormData;
    const group = JSON.parse(String(form.get("media")));
    expect(group.map((item: { caption?: string }) => item.caption)).toEqual([
      "caption",
      undefined,
      undefined,
    ]);
  });

  it.each([
    ["one message for two files", 2, [11]],
    ["two messages for three files", 3, [11, 12]],
    ["four messages for three files", 3, [11, 12, 13, 14]],
  ])("an album answered with %s is an unknown outcome", async (_name, files, ids) => {
    const { context } = fake({ sendMediaGroup: ok(ids.map((id) => ({ message_id: id }))) });
    const result = await createTelegramAdapter().commit(
      { ...context, media: mediaOf(files) },
      {
        idempotencyKey: "album-2",
        text: "",
        account,
        mediaIds: Array.from({ length: files }, (_one, index) => String(index)),
      },
    );
    expect(result).toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
  });
});

describe("what is checked before an image is sent", () => {
  it.each([
    ["a caption over 1024 characters", "x".repeat(1025), mediaOf(1), "caption_too_long"],
    ["eleven images", "ok", mediaOf(11), "too_many_media"],
    ["a video type", "ok", mediaOf(1, "video/mp4"), "media_unsupported"],
    ["a photo one byte over 10 MB", "ok", mediaOf(1, "image/png", 10_000_001), "media_too_large"],
  ])("%s is refused before anything is sent", async (_name, text, media, code) => {
    const { context, calls } = fake({});
    const result = await createTelegramAdapter().prepare(
      { ...context, media },
      { idempotencyKey: "refuse-1", text, account },
    );
    expect(result).toMatchObject({ ok: false, effect: "none", errorClass: "permanent", providerCode: code });
    expect(calls).toHaveLength(0);
  });

  it("prepare answers one position per call so each medium is checked", async () => {
    const { context } = fake({});
    const adapter = createTelegramAdapter();
    const first = await adapter.prepare(
      { ...context, media: mediaOf(2) },
      { idempotencyKey: "p-1", text: "t", account, mediaIds: [] },
    );
    const last = await adapter.prepare(
      { ...context, media: mediaOf(2) },
      { idempotencyKey: "p-1", text: "t", account, mediaIds: ["0", "1"] },
    );
    expect(first.upload).toEqual({ mediaId: "0" });
    expect(last).toMatchObject({ ok: true, effect: "none" });
    expect(last.upload).toBeUndefined();
  });
});

const post = (externalId: string) => ({ externalId, account });

describe("editing and deleting", () => {
  it.each([
    ["text", "t:5", "editMessageText", { text: "new &lt;" }],
    ["a photo caption", "p:5", "editMessageCaption", { caption: "new &lt;" }],
    ["the first message of an album", "a:5,6", "editMessageCaption", { caption: "new &lt;" }],
  ])("an edit of %s", async (_name, externalId, method, fields) => {
    const { context, calls } = fake({ [method]: ok({ message_id: 5 }) });
    const result = await createTelegramAdapter().edit?.(context, post(externalId), { text: "new <" });
    expect(result).toMatchObject({ ok: true, effect: "confirmed", externalId });
    expect(calls[0]).toMatchObject({
      method,
      body: { chat_id: CHAT, message_id: 5, parse_mode: "HTML", ...fields },
    });
  });

  it("an edit that changes nothing is an applied edit", async () => {
    const { context } = fake({ editMessageText: refusal(400, "Bad Request: message is not modified") });
    const result = await createTelegramAdapter().edit?.(context, post("t:5"), { text: "same" });
    expect(result).toMatchObject({ ok: true, effect: "confirmed" });
  });

  it("a delete of one message", async () => {
    const { context, calls } = fake({ deleteMessage: ok(true) });
    const result = await createTelegramAdapter().delete(context, post("t:5"));
    expect(result).toMatchObject({ ok: true, effect: "confirmed" });
    expect(calls[0]).toMatchObject({ method: "deleteMessage", body: { chat_id: CHAT, message_id: 5 } });
  });

  it.each([
    ["a message already gone", "Bad Request: message to delete not found", { ok: true, effect: "none" }],
    [
      "a message too old to delete",
      "Bad Request: message can't be deleted",
      { ok: false, effect: "none", providerCode: "action_refused" },
    ],
  ])("a delete of %s", async (_name, description, expected) => {
    const { context } = fake({ deleteMessage: refusal(400, description) });
    expect(await createTelegramAdapter().delete(context, post("t:5"))).toMatchObject(expected);
  });
});

// deleteMessages skips what it cannot find and still answers true, so one delete per message is the only proof.
describe("deleting an album", () => {
  const gone = () => refusal(400, "Bad Request: message to delete not found");
  const stuck = () => refusal(400, "Bad Request: message can't be deleted");
  it.each([
    [
      "every message is deleted in order",
      [ok(true), ok(true), ok(true)],
      3,
      { ok: true, effect: "confirmed" },
    ],
    ["one is already gone", [ok(true), gone(), ok(true)], 3, { ok: true, effect: "confirmed" }],
    ["all are already gone", [gone(), gone(), gone()], 3, { ok: true, effect: "none" }],
    [
      "a refusal partway ends it and is the answer",
      [ok(true), stuck(), ok(true)],
      2,
      { ok: false, effect: "none", providerCode: "action_refused" },
    ],
  ])("an album delete where %s", async (_name, answers, sent, expected) => {
    const { context, calls } = fake({ deleteMessage: answers });
    const result = await createTelegramAdapter().delete(context, post("a:5,6,7"));
    expect(result).toMatchObject(expected);
    expect(calls.map((call) => call.method)).toEqual(Array(sent).fill("deleteMessage"));
    expect(calls.map((call) => (call.body as { message_id: number }).message_id)).toEqual(
      [5, 6, 7].slice(0, sent),
    );
  });
});

describe("inspecting the bot in the chat", () => {
  it.each([
    ["the chat creator counts as an admin", "channel", { status: "creator" }, "ok"],
    [
      "a channel admin without the post right is limited",
      "channel",
      { status: "administrator", can_post_messages: false },
      "degraded",
    ],
    [
      "a channel admin with the post right",
      "channel",
      { status: "administrator", can_post_messages: true },
      "ok",
    ],
    ["a plain member of a channel cannot post", "channel", { status: "member" }, "degraded"],
    ["a plain member of a group may post", "supergroup", { status: "member" }, "ok"],
    ["a group admin states no post right and may post", "supergroup", { status: "administrator" }, "ok"],
  ] as const)("%s", async (_name, chatType, member, health) => {
    const { context } = fake({
      getMe: ok({ id: 42, username: "shoutory_bot" }),
      getChat: ok({ id: -1, type: chatType }),
      getChatMember: ok(member),
    });
    const result = await createTelegramAdapter().inspect(context, {
      accessToken: new SealedSecret(TOKEN),
      providerAccountId: CHAT,
    });
    expect(result).toMatchObject({ ok: true, health });
  });

  it("a chat the bot can no longer read is limited, not an error", async () => {
    const { context } = fake({
      getMe: ok({ id: 42, username: "shoutory_bot" }),
      getChat: refusal(400, "Bad Request: chat not found"),
    });
    const result = await createTelegramAdapter().inspect(context, {
      accessToken: new SealedSecret(TOKEN),
      providerAccountId: CHAT,
    });
    expect(result).toMatchObject({ ok: true, health: "degraded" });
  });
});
