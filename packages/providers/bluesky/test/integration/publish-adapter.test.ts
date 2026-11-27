import type { MediaReader } from "@shoutory/provider-sdk/adapter";
import { describe, expect, it } from "vitest";
import { createBlueskyAdapter } from "../../src/adapter.js";
import { accountOf, DID, makeKeys, network } from "../support/network.js";

const adapter = createBlueskyAdapter();
const keys = makeKeys();
const account = accountOf(keys);
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

const reader = (items: readonly { mime: string; size: number; alt?: string }[]): MediaReader => ({
  items: items.map(({ mime, size, alt }) => ({ mime, size, altText: alt ?? null })),
  read: async (position) => ({ bytes: PNG, altText: items[position]?.alt ?? null }),
});

const uploads = (net: Awaited<ReturnType<typeof network>>) =>
  net.seen.filter(({ url }) => url.endsWith("com.atproto.repo.uploadBlob"));

describe("a crash after createRecord", () => {
  it("is reconciled by getRecord on the same rkey and never creates twice", async () => {
    const net = await network({ nonces: false, createFails: "cut" });
    const sent = await adapter.commit(net.context, {
      idempotencyKey: "crash-marker-1",
      text: "once",
      account,
    });
    expect(sent.effect).toBe("possible");
    const found = await adapter.readBack(net.context, { idempotencyKey: "crash-marker-1", account });
    expect(found.ok).toBe(true);
    expect(found.externalId).toMatch(new RegExp(`^at://${DID}/app.bsky.feed.post/`));
    expect(net.sim.stored()).toHaveLength(1);
    expect(net.sim.created()).toBe(1);
  });

  it("is read as absent when nothing was created", async () => {
    const net = await network({ nonces: false });
    const found = await adapter.readBack(net.context, { idempotencyKey: "never-sent-1", account });
    expect(found.ok).toBe(false);
    expect(found.absent).toBe(true);
    expect(found.effect).toBe("none");
  });
});

describe("a key that holds a record already", () => {
  it.each(["overwrite", "error"] as const)(
    "never leaves a second record when the server %ss, and the read-back finds the first",
    async (duplicateRkey) => {
      const net = await network({ nonces: false, duplicateRkey });
      const first = await adapter.commit(net.context, {
        idempotencyKey: "same-marker-1",
        text: "a",
        account,
      });
      await adapter.commit(net.context, { idempotencyKey: "same-marker-1", text: "a", account });
      const found = await adapter.readBack(net.context, { idempotencyKey: "same-marker-1", account });
      expect(net.sim.stored()).toHaveLength(1);
      expect(found.externalId).toBe(first.externalId);
    },
  );
});

describe("thread parts and a first comment", () => {
  it("are replies that name their parent and the root of the thread", async () => {
    const net = await network({ nonces: false });
    const post = async (marker: string, replyToExternalId?: string) => {
      const answer = await adapter.commit(net.context, {
        idempotencyKey: marker,
        text: marker,
        account,
        ...(replyToExternalId === undefined ? {} : { replyToExternalId }),
      });
      expect(answer.ok).toBe(true);
      return answer.externalId ?? "";
    };
    const root = await post("part-1");
    const second = await post("part-2", root);
    const third = await post("part-3", second);
    const replies = [...net.sim.records().values()]
      .map(({ value }) => value.reply as { root: { uri: string }; parent: { uri: string } } | undefined)
      .filter((reply) => reply !== undefined);
    expect(replies.map((reply) => [reply.parent.uri, reply.root.uri])).toEqual([
      [root, root],
      [second, root],
    ]);
    expect(third).not.toBe(second);
  });
});

describe("images", () => {
  it("are uploaded one per step and attached with their alt text", async () => {
    const net = await network({ nonces: false });
    const media = reader([
      { mime: "image/png", size: PNG.length, alt: "first picture" },
      { mime: "image/png", size: PNG.length, alt: "second picture" },
    ]);
    const context = { ...net.context, media };
    const ids: string[] = [];
    for (let step = 0; step < 2; step += 1) {
      const answer = await adapter.prepare(context, {
        idempotencyKey: "media-marker-1",
        text: "t",
        account,
        mediaIds: ids,
      });
      expect(answer.ok).toBe(true);
      ids.push(answer.upload?.mediaId ?? "");
    }
    const posted = await adapter.commit(context, {
      idempotencyKey: "media-marker-1",
      text: "pictures",
      account,
      mediaIds: ids,
    });
    expect(posted.ok).toBe(true);
    const embed = [...net.sim.records().values()][0]?.value.embed as { images: { alt: string }[] };
    expect(embed.images.map((image) => image.alt)).toEqual(["first picture", "second picture"]);
  });

  it.each([
    ["five images", Array.from({ length: 5 }, () => ({ mime: "image/png", size: 10 }))],
    ["an image over 2,000,000 bytes", [{ mime: "image/png", size: 2_000_001 }]],
    ["a video", [{ mime: "video/mp4", size: 10 }]],
  ])("%s is refused before the first byte is sent", async (_name, items) => {
    const net = await network({ nonces: false });
    const answer = await adapter.prepare(
      { ...net.context, media: reader(items) },
      { idempotencyKey: "media-marker-2", text: "t", account, mediaIds: [] },
    );
    expect(answer.ok).toBe(false);
    expect(answer.errorClass).toBe("permanent");
    expect(uploads(net)).toHaveLength(0);
  });
});

describe("delete", () => {
  it("removes the record, and a record already gone is no error", async () => {
    const net = await network({ nonces: false });
    const made = await adapter.commit(net.context, {
      idempotencyKey: "delete-marker-1",
      text: "bye",
      account,
    });
    const post = { externalId: made.externalId ?? "", account };
    expect((await adapter.delete(net.context, post)).effect).toBe("confirmed");
    expect(net.sim.stored()).toHaveLength(0);
    const again = await adapter.delete(net.context, post);
    expect(again.ok).toBe(true);
  });
});
