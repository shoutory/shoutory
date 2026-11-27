import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import { startMastodonSimulator } from "@shoutory/provider-mastodon/simulator";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { ledgerCredentials } from "../support/ledger-credentials.js";
import {
  opOf,
  plant,
  rows,
  sleep,
  takeBack,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";
import { type Pin, pinMedia } from "../support/ledger-media.js";

useDispatchEnv();

// A call needs more than 10 seconds of lease left to start, so a lease this short would hand a row back between beats.
const LEASE = 24;
const manifest = {
  ...mastodonManifest,
  leaseSeconds: { prepare: LEASE, commit: LEASE, readBack: LEASE, edit: LEASE, delete: LEASE },
};
const provider = {
  providerId: manifest.id,
  queueName: `publish.${manifest.id}`,
  reconcileQueue: `reconcile.${manifest.id}`,
  lease: LEASE,
};
const HOST = "media.example";

let sim: Awaited<ReturnType<typeof startMastodonSimulator>>;
let dir: string;
let storage: ReturnType<typeof createFsDriver>;
// The worker's own clock, so a test can move it past the lease without waiting.
let skew = 0;
let afterUpload: () => void = () => undefined;
const logger = createLogger({ secrets: [], stream: { write: () => undefined } });

let uploadDelayMs = 0;
let uploadAborted = false;
const waitFor = (ms: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        uploadAborted = true;
        reject(new DOMException("the call was aborted", "AbortError"));
      },
      { once: true },
    );
  });

const fetchFor = (): typeof fetch => async (input, init) => {
  const url = new URL(String(input));
  if (init?.method === "POST" && url.pathname === "/api/v2/media" && uploadDelayMs > 0)
    await waitFor(uploadDelayMs, init.signal);
  const answer = await fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  if (init?.method === "POST" && url.pathname === "/api/v2/media") afterUpload();
  return answer;
};
const registry = createRegistry([manifest]);
const adapters = { [manifest.id]: createMastodonAdapter() };
const turn = () => {
  const options = {
    pool: workerPool(),
    logger,
    registry,
    adapters,
    fetchFor,
    credentials: ledgerCredentials(workerPool(), { registry, adapters, fetchFor }),
    queue: provider.queueName,
    owner: "owner-media",
    closing: new AbortController().signal,
    now: () => performance.now() + skew,
    storage,
  };
  return runTurn(options);
};
const reset = () => {
  sim.reset();
  skew = 0;
  afterUpload = () => undefined;
  uploadDelayMs = 0;
  uploadAborted = false;
};
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
  dir = await mkdtemp(join(tmpdir(), "shoutory-media-upload-"));
  storage = createFsDriver(dir);
});
afterAll(async () => {
  await sim.close();
  await rm(dir, { recursive: true, force: true });
});

const PNG: Pin = { stored: "png-bytes-1", mime: "image/png", alt: "نص بديل" };
const MP4: Pin = { stored: "mp4-bytes-1", mime: "video/mp4" };
async function planted(pins: Pin[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = await plant(provider, { host: HOST, token: sim.issueToken() });
  await pinMedia(storage, id, pins);
  for (const [column, value] of Object.entries(extra))
    await rows(`UPDATE app.operations SET ${column} = $2 WHERE id = $1`, [id, value]);
  return id;
}
const statuses = () =>
  sim.requests
    .filter((request) => request.method === "POST" && request.path === "/api/v1/statuses")
    .map((request) => JSON.parse(request.body.toString("utf8")) as { status: string; media_ids?: string[] });
const progressOf = async (id: string) =>
  (
    await rows(
      `SELECT step_cursor, provider_refs, next_check_at IS NOT NULL AS checked,
         extract(epoch FROM processing_deadline - clock_timestamp())::float8 AS deadline_in
       FROM app.operations WHERE id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;

describe("a post's media is uploaded before it is published", () => {
  it("sends an image with its Arabic alt text to v2 and the post carries its id", async () => {
    reset();
    const id = await planted([PNG]);
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed" });
    const [medium] = sim.media();
    expect(medium).toMatchObject({ description: PNG.alt, mime: "image/png" });
    expect(medium?.bytes.toString()).toBe(PNG.stored);
    expect(statuses().map((status) => status.media_ids)).toEqual([[medium?.id]]);
  });

  it("moves a post whose video is still processing to processing and sends no status", async () => {
    reset();
    const id = await planted([MP4]);
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "processing", effect: "none" });
    const progress = await progressOf(id);
    expect(progress).toMatchObject({ step_cursor: "await_processing", checked: true });
    expect(progress.provider_refs).toEqual({ media: [{ id: sim.media()[0]?.id, processing: true }] });
    expect(Number(progress.deadline_in)).toBeGreaterThan(590);
    expect(Number(progress.deadline_in)).toBeLessThanOrEqual(600);
    expect(statuses()).toEqual([]);
  });

  it("reuses an id that is already stored and uploads only the rest", async () => {
    reset();
    const refs = JSON.stringify({ media: [{ id: "remote-stored-1", processing: false }] });
    const id = await planted([PNG, { ...PNG, stored: "png-bytes-2", alt: "second" }], {
      step_cursor: "prepare:1",
      provider_refs: refs,
    });
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "published" });
    expect(sim.media().map((medium) => medium.description)).toEqual(["second"]);
    expect(statuses().map((status) => status.media_ids)).toEqual([["remote-stored-1", sim.media()[0]?.id]]);
  });

  it("hands the row back when the lease is nearly spent and the next turn uploads only the rest", async () => {
    reset();
    const id = await planted([PNG, { ...PNG, stored: "png-bytes-2", alt: "second" }]);
    afterUpload = () => {
      skew += 100_000;
    };
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "pending", effect: "none" });
    expect(sim.media()).toHaveLength(1);
    expect((await progressOf(id)).step_cursor).toBe("prepare:1");
    afterUpload = () => undefined;
    skew = 0;
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "published" });
    expect(sim.media().map((medium) => medium.description)).toEqual([PNG.alt, "second"]);
  });
});

describe("the deadline of an upload call", () => {
  it("lets an upload that takes longer than the lease finish while the heartbeats renew it", async () => {
    reset();
    uploadDelayMs = (LEASE + 3) * 1000;
    const id = await planted([PNG]);
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "published" });
    expect(uploadAborted).toBe(false);
    expect(sim.media()).toHaveLength(1);
  }, 60_000);

  it("aborts an upload at once when the heartbeat loses the lease", async () => {
    reset();
    uploadDelayMs = 30_000;
    const id = await planted([PNG]);
    const running = turn();
    await sleep(1_000);
    await takeBack(id);
    const result = await running;
    expect(result.kind).toBe("lost");
    expect(uploadAborted).toBe(true);
    expect(sim.media()).toHaveLength(0);
    // The sweep gave the row back; it must not be the next test's turn.
    await rows("UPDATE app.operations SET next_attempt_at = now() + interval '1 day' WHERE id = $1", [id]);
  }, 40_000);
});

// [the instance's answer to the upload, the state the row waits in, its effect]; no status is ever sent
const FAILED: [string, number, Record<string, string>, string][] = [
  ["a 429 with Retry-After", 429, { "retry-after": "7" }, "retry_wait"],
  ["a 503", 503, {}, "retry_wait"],
  ["a 422", 422, {}, "failed"],
];
describe("an upload the instance answers with an error", () => {
  it.each(FAILED)(
    "%s leaves the row in %s with no effect and sends no status",
    async (_n, status, headers, state) => {
      reset();
      sim.faults.failNext("POST /api/v2/media", { kind: "respond", status, body: { error: "x" }, headers });
      const id = await planted([PNG]);
      await turn();
      expect(await opOf(id)).toMatchObject({ state, effect: "none" });
      expect(statuses()).toEqual([]);
    },
  );
});

const bucketOf = (account: string, name: string) =>
  createHash("sha256").update(["mastodon", name, "account", account].join("\0")).digest("hex");
const tokensOf = async (account: string, name: string) =>
  (
    await rows("SELECT tokens FROM app.rate_buckets WHERE scope = 'account' AND key = $1", [
      bucketOf(account, name),
    ])
  )[0]?.tokens;
const accountOf = async (id: string) =>
  String(
    (
      await rows(
        "SELECT c.provider_account_id AS a FROM app.channels c JOIN app.operations o ON o.channel_id = c.id WHERE o.id = $1",
        [id],
      )
    )[0]?.a,
  );

// [the media on the post, the tokens left in the media bucket (a bucket never touched has none), in the delete bucket]
const SPENDING: [string, Pin[], number | undefined][] = [
  ["a text post", [], undefined],
  ["a post with two images", [PNG, { ...PNG, stored: "png-bytes-2", alt: "second" }], 28],
];
describe("the limits a turn spends", () => {
  it.each(SPENDING)(
    "%s spends the media tokens per upload and never a delete token",
    async (_n, pins, left) => {
      reset();
      const id = await planted(pins);
      await turn();
      expect(await opOf(id)).toMatchObject({ state: "published" });
      const account = await accountOf(id);
      // A bucket refills a little between the take and the read, so whole tokens are compared.
      const whole = async (name: string) => {
        const tokens = await tokensOf(account, name);
        return tokens === undefined ? undefined : Math.floor(Number(tokens));
      };
      expect(await whole("media")).toBe(left);
      expect(await whole("delete")).toBeUndefined();
      expect(await whole("api")).toBe(299);
    },
  );
});

describe("the frozen settings and locale of a variant", () => {
  const BY_LOCALE = [
    ["no locale", null, { status: "text of the default", visibility: "public" }],
    [
      "a locale",
      "ar",
      { status: "نص النسخة العربية", visibility: "unlisted", sensitive: true, language: "ar" },
    ],
  ] as const;
  it.each(BY_LOCALE)("two locales of one channel send their own: %s", async (_n, locale, expected) => {
    reset();
    const id = await planted([]);
    await rows(
      "UPDATE app.post_variants SET locale = $2 WHERE id = (SELECT variant_id FROM app.operations WHERE id = $1)",
      [id, locale],
    );
    const [row] = await rows(
      "SELECT snapshot FROM app.post_versions WHERE id = (SELECT frozen_version_id FROM app.operations WHERE id = $1)",
      [id],
    );
    const snapshot = row?.snapshot as {
      draft: { variants: { channel_id: string }[] };
      resolved: { variants: object[] };
    };
    const [first] = snapshot.draft.variants;
    if (first === undefined) throw new Error("the planted snapshot holds no variant");
    const own = (text: string, settings: object, tag: string | null) => ({
      draft: { ...first, text, locale: tag },
      resolved: { channel_id: first.channel_id, locale: tag, settings },
    });
    const pair = [
      own("text of the default", { visibility: "public" }, null),
      own("نص النسخة العربية", { visibility: "unlisted", sensitive: true }, "ar"),
    ];
    snapshot.draft.variants = pair.map((one) => one.draft);
    snapshot.resolved.variants = pair.map((one) => one.resolved);
    await rows(
      "UPDATE app.post_versions SET snapshot = $2 WHERE id = (SELECT frozen_version_id FROM app.operations WHERE id = $1)",
      [id, snapshot],
    );
    await turn();
    expect(statuses()).toEqual([expect.objectContaining(expected)]);
  });
});

describe("the frozen text of a variant", () => {
  it.each([
    ["a variant with no locale", null, "text of the default"],
    ["a variant with a locale", "ar", "نص النسخة العربية"],
  ])("is read by channel and locale: %s", async (_n, locale, expected) => {
    reset();
    const id = await planted([]);
    await rows(
      "UPDATE app.post_variants SET locale = $2 WHERE id = (SELECT variant_id FROM app.operations WHERE id = $1)",
      [id, locale],
    );
    await rows(
      `UPDATE app.post_versions SET snapshot = jsonb_set(snapshot, '{draft,variants}',
         (snapshot #> '{draft,variants}') || jsonb_build_array(
           jsonb_set(jsonb_set(snapshot #> '{draft,variants,0}', '{locale}', '"ar"'), '{text}', to_jsonb($2::text)))
         || '[]'::jsonb)
       WHERE id = (SELECT frozen_version_id FROM app.operations WHERE id = $1)`,
      [id, "نص النسخة العربية"],
    );
    await rows(
      `UPDATE app.post_versions SET snapshot = jsonb_set(snapshot, '{draft,variants,0,text}', to_jsonb($2::text))
       WHERE id = (SELECT frozen_version_id FROM app.operations WHERE id = $1)`,
      [id, "text of the default"],
    );
    await turn();
    expect(statuses().map((status) => status.status)).toEqual([expected]);
  });
});
