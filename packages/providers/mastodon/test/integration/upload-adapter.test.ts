import {
  type AdapterContext,
  type MediaItem,
  MediaReadError,
  type MediaReader,
} from "@shoutory/provider-sdk/adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/instance.js";

let sim: MastodonSimulator;
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const adapter = createMastodonAdapter();
const PNG = { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
const MP4 = { mime: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) };

interface Medium {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly alt?: string | null;
  readonly size?: number;
}
function withMedia(base: AdapterContext, media: readonly Medium[]): AdapterContext {
  const items: MediaItem[] = media.map((one) => ({
    mime: one.mime,
    size: one.size ?? one.bytes.length,
    altText: one.alt ?? null,
  }));
  const reader: MediaReader = {
    items,
    read: async (position) => {
      const one = media[position];
      if (one === undefined) throw new Error("not pinned");
      return { bytes: one.bytes, altText: one.alt ?? null };
    },
  };
  return { ...base, media: reader };
}
const upload = (media: readonly Medium[], done: string[] = [], over?: Partial<AdapterContext>) => {
  const { context, seen } = recorder(sim);
  const account = accountOf(sim.issueToken());
  return {
    seen,
    result: adapter.prepare(
      { ...withMedia(context, media), ...over },
      { idempotencyKey: "upload-key-1", text: "t", account, mediaIds: done },
    ),
  };
};

describe("a media upload", () => {
  // [medium, the answer: ready (200) or still processing (202)]
  it.each([
    ["an image is ready at once", { ...PNG, alt: "a red door" }, false],
    ["a video is still processing", { ...MP4, alt: "نص بديل للفيديو" }, true],
  ] as const)(
    "%s: v2 is called with the alt text and the bytes, never v1",
    async (_name, medium, processing) => {
      sim.reset();
      const { seen, result } = upload([medium]);
      const answer = await result;
      expect(answer).toMatchObject({ ok: true, effect: "none" });
      expect(answer.upload?.mediaId).toBeTruthy();
      expect(answer.upload?.processing !== undefined).toBe(processing);
      expect(seen.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([
        "/api/v2/media",
      ]);
      const [stored] = sim.media();
      expect(stored).toMatchObject({ mime: medium.mime, description: medium.alt });
      expect([...(stored?.bytes ?? [])]).toEqual([...medium.bytes]);
      expect(sim.effects()).toBe(0);
    },
  );

  it("uploads only the medium after the ones already stored, and nothing when all are", async () => {
    sim.reset();
    const media = [
      { ...PNG, alt: "first" },
      { ...PNG, alt: "second" },
    ];
    await await upload(media, ["remote-1"]).result;
    expect(sim.media().map((one) => one.description)).toEqual(["second"]);
    sim.reset();
    const done = await upload(media, ["remote-1", "remote-2"]).result;
    expect(done).toMatchObject({ ok: true, effect: "none" });
    expect(done.upload).toBeUndefined();
    expect(sim.media()).toHaveLength(0);
  });

  it("reads the instance's limits with the first medium only, so a later medium's step sends only its upload", async () => {
    sim.reset();
    const media = [
      { ...PNG, alt: "first" },
      { ...PNG, alt: "second" },
    ];
    const first = upload(media, []);
    await first.result;
    const second = upload(media, ["remote-1"]);
    await second.result;
    expect(first.seen.map((request) => request.path)).toEqual(["/api/v2/instance", "/api/v2/media"]);
    expect(second.seen.map((request) => request.path)).toEqual(["/api/v2/media"]);
  });

  it("sends nothing for a post without media", async () => {
    sim.reset();
    const { seen, result } = upload([]);
    expect(await result).toMatchObject({ ok: true, effect: "none" });
    expect(seen).toHaveLength(0);
  });
});

async function pollOf(ids: string[], token = sim.issueToken()) {
  const { context, seen } = recorder(sim);
  if (adapter.pollMedia === undefined) throw new Error("the adapter has no media poll");
  return { seen, answer: await adapter.pollMedia(context, { mediaIds: ids, account: accountOf(token) }) };
}
async function uploadedVideo(): Promise<string> {
  const made = await upload([MP4]).result;
  return String(made.upload?.mediaId);
}

// GET /api/v1/media/:id (docs.joinmastodon.org/methods/media, read 2026-11-27): 200 when the medium is ready, 206 while it
// is still being processed.
describe("a poll of media the instance is still processing", () => {
  it("answers processing on 206 and ready on 200, one read per call, with the owner's token and no send", async () => {
    sim.reset({ processingPolls: 2 });
    const id = await uploadedVideo();
    const token = sim.issueToken();
    const answers = [await pollOf([id], token), await pollOf([id], token), await pollOf([id], token)];
    expect(answers.map(({ answer }) => answer.mediaPoll?.ready)).toEqual([false, false, true]);
    expect(answers[0]?.answer).toMatchObject({ ok: true, effect: "none" });
    expect(answers[0]?.answer.mediaPoll?.checkInSeconds).toBeGreaterThan(0);
    const reads = sim.requests.filter((request) => request.path === `/api/v1/media/${id}`);
    expect(reads.map((request) => [request.method, request.headers.authorization])).toEqual(
      Array(3).fill(["GET", `Bearer ${token}`]),
    );
    expect(sim.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
    expect(sim.effects()).toBe(0);
  });

  it("reads every id in order and stops at the first that is still processing", async () => {
    sim.reset({ processingPolls: 1 });
    const [first, second] = [await uploadedVideo(), await uploadedVideo()];
    const { answer } = await pollOf([first, second]);
    expect(answer.mediaPoll?.ready).toBe(false);
    expect(sim.requests.filter((request) => request.path.startsWith("/api/v1/media/"))).toHaveLength(1);
  });

  // [the instance's answer, the result class]: a 404 carries its status so the ledger can keep waiting
  it.each([
    [422, "permanent", 422],
    [404, "permanent", 404],
    [500, "retryable_before_send", undefined],
    [429, "rate_limited", undefined],
  ] as const)("a %s is class %s with no effect", async (status, errorClass, httpStatus) => {
    sim.reset();
    const id = await uploadedVideo();
    sim.arm("poll", { kind: "respond", status });
    const { answer } = await pollOf([id]);
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass });
    expect(answer.httpStatus).toBe(httpStatus);
  });

  it("refuses an id that is not an id and makes no request", async () => {
    sim.reset();
    const { answer, seen } = await pollOf(["../accounts/1"]);
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "permanent" });
    expect(seen).toHaveLength(0);
  });
});

// [what is wrong, the media, the instance's limits]: no upload is made and the refusal is permanent with no effect
const REFUSED: [string, Medium[], Record<string, number | null>][] = [
  ["more files than the instance allows", [PNG, PNG, PNG], { maxMedia: 2 }],
  ["a type the instance does not support", [{ mime: "image/heic", bytes: PNG.bytes }], {}],
  ["an image over the image limit", [{ ...PNG, size: 11 }], { imageSizeLimit: 10 }],
  ["a video over the video limit", [{ ...MP4, size: 11 }], { videoSizeLimit: 10 }],
  ["alt text over the description limit", [{ ...PNG, alt: "ab".repeat(5) }], { descriptionLimit: 9 }],
  ["alt text of Arabic letters counted by code point", [{ ...PNG, alt: "نصنصن" }], { descriptionLimit: 4 }],
];
describe("a medium the instance would refuse (checked before any upload)", () => {
  it.each(REFUSED)("%s", async (_name, media, limits) => {
    sim.reset({ limits });
    const { result } = upload(media);
    expect(await result).toMatchObject({ ok: false, effect: "none", errorClass: "permanent" });
    expect(sim.media()).toHaveLength(0);
  });
});

// [the situation, how the simulator answers an upload, the class]; every one leaves no post behind
const HEADERS = (reset: string) => ({ "x-ratelimit-reset": reset });
const FAILURES: [string, number, Record<string, string>, string][] = [
  ["429 with seconds", 429, { "retry-after": "7" }, "rate_limited"],
  [
    "429 with an HTTP date",
    429,
    { "retry-after": new Date(Date.now() + 30_000).toUTCString() },
    "rate_limited",
  ],
  [
    "429 with the documented reset",
    429,
    HEADERS(new Date(Date.now() + 30_000).toISOString()),
    "rate_limited",
  ],
  ["503", 503, {}, "retryable_before_send"],
  ["500", 500, {}, "retryable_before_send"],
  ["422", 422, {}, "permanent"],
  ["413", 413, {}, "permanent"],
];
describe("an upload that fails", () => {
  it.each(FAILURES)("%s is %s with no effect", async (_name, status, headers, errorClass) => {
    sim.reset();
    sim.faults.failNext("POST /api/v2/media", { kind: "respond", status, body: { error: "x" }, headers });
    const answer = await upload([PNG]).result;
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass });
    expect(sim.media()).toHaveLength(0);
  });

  // The codes undici raises (github.com/nodejs/undici docs/docs/api/Errors.md, read 2026-11-27) and Node's own socket
  // codes: a call that did not connect or was cut off leaves no post, so the upload is tried again.
  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "EPIPE",
    "ECONNREFUSED",
  ])("a %s is retryable before send with no effect", async (code) => {
    sim.reset();
    const failing: typeof fetch = () =>
      Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) }));
    const { context } = recorder(sim);
    const answer = await adapter.prepare(withMedia({ ...context, fetch: failing }, [PNG]), {
      idempotencyKey: "upload-key-2",
      text: "t",
      account: accountOf(sim.issueToken()),
      mediaIds: [],
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "retryable_before_send" });
  });

  it("a medium the reader refuses is permanent with no effect and no upload", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const refusing: AdapterContext = {
      ...context,
      media: {
        items: [{ mime: "image/png", size: 7, altText: null }],
        read: () => Promise.reject(new MediaReadError("refused")),
      },
    };
    const answer = await adapter.prepare(refusing, {
      idempotencyKey: "upload-key-3",
      text: "t",
      account: accountOf(sim.issueToken()),
      mediaIds: [],
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "permanent" });
    expect(sim.media()).toHaveLength(0);
  });
});
