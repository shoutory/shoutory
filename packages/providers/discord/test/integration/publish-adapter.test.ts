import { describe, expect, it } from "vitest";
import { createDiscordAdapter } from "../../src/adapter.js";
import { accountOf, json, MESSAGE_ID, scripted, WEBHOOK_ID, WEBHOOK_TOKEN } from "../support/webhook.js";

const adapter = createDiscordAdapter();
const account = accountOf();
const post = { externalId: MESSAGE_ID, account };
const MESSAGE = { id: MESSAGE_ID, content: "hello" };
const HOOK = `/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

const mediaOf = (sizes: readonly number[], altText: string | null = null) => ({
  items: sizes.map((size) => ({ mime: "image/png", size, altText })),
  read: async (position: number) => ({ bytes: new Uint8Array(sizes[position] ?? 0).fill(7), altText }),
});

describe("a send", () => {
  it("posts the text with wait=true and takes the message id as the external id", async () => {
    const { context, seen } = scripted([json(200, MESSAGE)]);
    const answer = await adapter.commit(context, { idempotencyKey: "send-1", text: "hello", account });
    expect(answer).toEqual({ ok: true, effect: "confirmed", externalId: MESSAGE_ID });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", contentType: "application/json" });
    expect(new URL(seen[0]?.url ?? "").pathname + new URL(seen[0]?.url ?? "").search).toBe(
      `${HOOK}?wait=true`,
    );
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ content: "hello" });
    expect(seen[0]?.userAgent).toMatch(/^DiscordBot \(/);
  });

  // Discord renders its own Markdown, links and mentions, so the text goes through exactly as written.
  it.each([
    ["Markdown", "**bold** _italic_ ~~gone~~ `code` > quote\n- item\n```ts\nconst a = 1;\n```"],
    ["a link and a bare URL", "[docs](https://example.com/a?b=1&c=%20d#e) https://example.com/x?y=1&z=2"],
    ["@everyone and @here", "@everyone @here <@&123456789012345678>"],
    ["a user mention", "hi <@123456789012345678> and <#323456789012345678>"],
    ["Arabic and an emoji", "مرحبا **عالم** 👨‍👩‍👧"],
  ])("sends %s byte for byte as the content", async (_name, text) => {
    const { context, seen } = scripted([json(200, MESSAGE)]);
    await adapter.commit(context, { idempotencyKey: "golden-1", text, account });
    expect(JSON.parse(String(seen[0]?.body)).content).toBe(text);
  });

  it.each([
    ["a 200 that holds no message", json(200, {})],
    ["a 200 whose id is not an id", json(200, { id: "../x", content: "hello" })],
    ["a 204", new Response(null, { status: 204 })],
  ])("%s is an unknown outcome, never a send that cannot have happened", async (_name, reply) => {
    const { context } = scripted([reply]);
    const answer = await adapter.commit(context, { idempotencyKey: "send-2", text: "hello", account });
    expect(answer).toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
  });
});

// A webhook's default is to ping users only (docs.discord.com/developers/resources/message, read 2026-11-27); the adapter
// states it, so a change of that default cannot make a pasted @everyone or role mention notify a whole server.
describe("every send and edit states which mentions may notify", () => {
  const bodyOf = (
    request: { body: string | Uint8Array | undefined } | undefined,
    multipart: boolean,
  ): unknown => {
    if (!multipart) return JSON.parse(String(request?.body));
    const text = Buffer.from(request?.body as Uint8Array).toString("latin1");
    return JSON.parse(String(/name="payload_json"[\s\S]*?\r\n\r\n(\{.*\})\r\n/.exec(text)?.[1]));
  };
  it.each([
    ["a send", false],
    ["a send with files", true],
    ["an edit", false],
  ])("%s", async (name, multipart) => {
    const { context, seen } = scripted([json(200, MESSAGE)]);
    const media = multipart ? { media: mediaOf([2]) } : {};
    if (name === "an edit") await adapter.edit?.(context, post, { text: "t" });
    else await adapter.commit({ ...context, ...media }, { idempotencyKey: "m", text: "t", account });
    expect(bodyOf(seen[0], multipart)).toMatchObject({ allowed_mentions: { parse: ["users"] } });
  });
});

describe("the files of a send", () => {
  it("go as multipart with the message in payload_json and the alt text as a description", async () => {
    const { context, seen } = scripted([json(200, MESSAGE)]);
    const answer = await adapter.commit(
      { ...context, media: mediaOf([3, 5], "a cat") },
      { idempotencyKey: "send-3", text: "hello", account, mediaIds: ["file-0", "file-1"] },
    );
    expect(answer.ok).toBe(true);
    const body = Buffer.from(seen[0]?.body as Uint8Array).toString("latin1");
    expect(seen[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="files[0]"; filename="file-0.png"');
    expect(body).toContain('name="files[1]"; filename="file-1.png"');
    const payload = /name="payload_json"[\s\S]*?\r\n\r\n(\{.*\})\r\n/.exec(body)?.[1];
    expect(JSON.parse(String(payload))).toMatchObject({
      content: "hello",
      attachments: [
        { id: 0, filename: "file-0.png", description: "a cat" },
        { id: 1, filename: "file-1.png", description: "a cat" },
      ],
    });
  });
});

describe("the checks on the files of a send", () => {
  it.each([
    ["a file over 20 MiB", [20 * 1024 ** 2 + 1], null],
    ["more than 10 files", Array.from({ length: 11 }, () => 1), null],
    ["a request over 25 MiB", [20 * 1024 ** 2, 6 * 1024 ** 2], null],
    ["alt text over 1024 characters", [1], "x".repeat(1025)],
  ])("%s is refused before anything is sent", async (_name, sizes, alt) => {
    const { context, seen } = scripted([]);
    const media = mediaOf(sizes, alt);
    const prepared = await adapter.prepare(
      { ...context, media },
      { idempotencyKey: "p", text: "t", account },
    );
    expect(prepared).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
    const sent = await adapter.commit(
      { ...context, media },
      { idempotencyKey: "p", text: "t", account, mediaIds: sizes.map((_, i) => `file-${i}`) },
    );
    expect(sent).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
    expect(seen).toEqual([]);
  });

  // The size and alt text on an item are what the caller says; the bytes and alt text read are what would be sent.
  it.each([
    ["bytes read that add up to over 25 MiB", 13 * 1024 ** 2, 13 * 1024 ** 2, null],
    ["alt text read that is over 1024 characters", 1, 1, "x".repeat(1025)],
  ])("%s are refused although the item says otherwise", async (_name, first, second, alt) => {
    const { context, seen } = scripted([]);
    const sizes = [first, second];
    const media = {
      items: sizes.map(() => ({ mime: "image/png", size: 1, altText: null })),
      read: async (position: number) => ({ bytes: new Uint8Array(sizes[position] ?? 0), altText: alt }),
    };
    const sent = await adapter.commit(
      { ...context, media },
      { idempotencyKey: "read-1", text: "t", account, mediaIds: ["file-0", "file-1"] },
    );
    expect(sent).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
    expect(seen).toEqual([]);
  });

  it("answers one position per medium and sends nothing while preparing", async () => {
    const { context, seen } = scripted([]);
    const media = mediaOf([1, 1]);
    const first = await adapter.prepare({ ...context, media }, { idempotencyKey: "p", text: "t", account });
    const second = await adapter.prepare(
      { ...context, media },
      { idempotencyKey: "p", text: "t", account, mediaIds: ["file-0"] },
    );
    expect([first.upload?.mediaId, second.upload?.mediaId]).toEqual(["file-0", "file-1"]);
    expect(seen).toEqual([]);
  });
});

describe("a read, edit and delete name only a message id", () => {
  it.each(["../x", "1?wait=true", "12", "a".repeat(20), ""])(
    "%j is refused before any request",
    async (id) => {
      const { context, seen } = scripted([]);
      const target = { externalId: id, account };
      const answers = await Promise.all([
        adapter.readBack(context, target),
        adapter.edit?.(context, target, { text: "t" }),
        adapter.delete(context, target),
      ]);
      for (const answer of answers)
        expect(answer).toMatchObject({ ok: false, providerCode: "invalid_input" });
      expect(seen).toEqual([]);
    },
  );
});

describe("a read, edit and delete of a message", () => {
  it("reads a message back by id with a GET and confirms only the same id", async () => {
    const { context, seen } = scripted([
      json(200, MESSAGE),
      json(200, { id: "323456789012345678", content: "x" }),
    ]);
    expect(await adapter.readBack(context, post)).toEqual({
      ok: true,
      effect: "confirmed",
      externalId: MESSAGE_ID,
    });
    expect(seen[0]).toMatchObject({ method: "GET" });
    expect(new URL(seen[0]?.url ?? "").pathname).toBe(`${HOOK}/messages/${MESSAGE_ID}`);
    expect(await adapter.readBack(context, post)).toMatchObject({ ok: false, errorClass: "unknown" });
  });

  it("reads the text a message holds so an edit lost in flight can be compared", async () => {
    const { context } = scripted([json(200, { id: MESSAGE_ID, content: "edited text" })]);
    expect(await adapter.readSource?.(context, post)).toMatchObject({
      ok: true,
      effect: "none",
      content: { text: "edited text", settings: {} },
    });
  });

  it("edits with a PATCH that carries only the content, and confirms only the same id", async () => {
    const { context, seen } = scripted([
      json(200, MESSAGE),
      json(200, { id: "323456789012345678", content: "x" }),
    ]);
    expect(await adapter.edit?.(context, post, { text: "second" })).toEqual({
      ok: true,
      effect: "confirmed",
      externalId: MESSAGE_ID,
    });
    expect(seen[0]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ content: "second" });
    expect(await adapter.edit?.(context, post, { text: "third" })).toMatchObject({
      ok: false,
      effect: "possible",
      errorClass: "unknown",
    });
  });

  it("deletes with a DELETE and a 204", async () => {
    const { context, seen } = scripted([new Response(null, { status: 204 })]);
    expect(await adapter.delete(context, post)).toEqual({ ok: true, effect: "confirmed" });
    expect(seen[0]).toMatchObject({ method: "DELETE" });
  });

  it.each([
    ["a 404 without a code", () => json(404, {})],
    ["a 404 with another code", () => json(404, { code: 10003, message: "Unknown Channel" })],
  ])("%s on a delete is no proof the message is gone", async (_name, reply) => {
    const { context } = scripted([reply()]);
    expect(await adapter.delete(context, post)).toMatchObject({ ok: false, errorClass: "permanent" });
  });
});

describe("rate limits", () => {
  it.each([
    [
      "the body delay, rounded up to milliseconds",
      json(429, { retry_after: 1.2345, global: false }),
      1235,
      undefined,
    ],
    [
      "a shared-scope limit, which is the resource's and not ours",
      json(429, { retry_after: 2 }, { "x-ratelimit-scope": "shared" }),
      2000,
      "rate_limit_shared",
    ],
  ])("a 429 reads %s", async (_name, reply, delay, code) => {
    const { context } = scripted([reply]);
    const answer = await adapter.commit(context, { idempotencyKey: "limit-1", text: "t", account });
    expect(answer).toMatchObject({
      ok: false,
      effect: "none",
      errorClass: "rate_limited",
      retryAfterMs: delay,
    });
    expect(answer.providerCode).toBe(code);
  });
});
