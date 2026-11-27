import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketKey } from "@shoutory/core/ledger/client";
import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import { startMastodonSimulator } from "@shoutory/provider-mastodon/simulator";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollStep } from "../../src/jobs/ledger/poll.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { ledgerCredentials } from "../support/ledger-credentials.js";
import {
  ledger,
  newWorkspace,
  opOf,
  plant,
  rows,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";
import { type Pin, pinMedia } from "../support/ledger-media.js";

useDispatchEnv();

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
const MP4: Pin = { stored: "mp4-bytes-1", mime: "video/mp4" };

let sim: Awaited<ReturnType<typeof startMastodonSimulator>>;
let dir: string;
let storage: ReturnType<typeof createFsDriver>;
let onPoll: () => Promise<void> = async () => undefined;
let logged: string[] = [];
const quiet = createLogger({ secrets: [], stream: { write: () => undefined } });
const capturing = createLogger({ secrets: [], stream: { write: (line: string) => void logged.push(line) } });

const fetchFor = (): typeof fetch => async (input, init) => {
  const url = new URL(String(input));
  if ((init?.method ?? "GET") === "GET" && url.pathname.startsWith("/api/v1/media/")) await onPoll();
  return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
};
const adapters = { [manifest.id]: createMastodonAdapter() };
const options = (logger = quiet, over: Record<string, unknown> = {}) => {
  const registry = createRegistry([{ ...manifest, ...over }]);
  return {
    pool: workerPool(),
    logger,
    registry,
    adapters,
    fetchFor,
    credentials: ledgerCredentials(workerPool(), { registry, adapters, fetchFor }),
    owner: "owner-poll",
    closing: new AbortController().signal,
    storage,
  };
};
const turn = () => runTurn({ ...options(), queue: provider.queueName });
const poll = (logger = quiet, over: Record<string, unknown> = {}) => pollStep(options(logger, over));

beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
  dir = await mkdtemp(join(tmpdir(), "shoutory-media-poll-"));
  storage = createFsDriver(dir);
});
afterAll(async () => {
  await sim.close();
  await rm(dir, { recursive: true, force: true });
});
const reset = (settings?: { processingPolls: number }) => {
  sim.reset(settings);
  onPoll = async () => undefined;
  logged = [];
};

interface Planted {
  id: string;
  token: string;
}
async function planted(extra: Record<string, unknown> = {}, workspace?: string): Promise<Planted> {
  const token = sim.issueToken();
  const id = await plant(provider, { host: HOST, token, ...(workspace === undefined ? {} : { workspace }) });
  await pinMedia(storage, id, [MP4]);
  for (const [column, value] of Object.entries(extra))
    await rows(`UPDATE app.operations SET ${column} = $2 WHERE id = $1`, [id, value]);
  return { id, token };
}
const due = (id: string) =>
  rows("UPDATE app.operations SET next_check_at = now() - interval '1 second' WHERE id = $1", [id]);
// An upload turn parks the video as processing; the poll is then due.
async function processing(workspace?: string): Promise<Planted & { media: string }> {
  const made = await planted({}, workspace);
  await turn();
  await due(made.id);
  const [row] = await rows("SELECT provider_refs FROM app.operations WHERE id = $1", [made.id]);
  const refs = row?.provider_refs as { media: { id: string }[] };
  return { ...made, media: String(refs.media[0]?.id) };
}
const statuses = () =>
  sim.requests
    .filter((request) => request.method === "POST" && request.path === "/api/v1/statuses")
    .map((request) => JSON.parse(request.body.toString("utf8")) as { media_ids?: string[] });
const polls = () =>
  sim.requests.filter((request) => request.method === "GET" && request.path.startsWith("/api/v1/media/"));

describe("a post whose video is ready is published once", () => {
  // SECURITY FLOOR
  it("after the first commit attempt a resend after an unknown goes straight to commit with the stored ids and is never polled", async () => {
    reset();
    const refs = JSON.stringify({ media: [{ id: "remote-stored-1", processing: true }] });
    const { id } = await planted({ step_cursor: "commit", provider_refs: refs, attempt_count: 1 });
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed" });
    expect(sim.requests.filter((request) => request.path.includes("/media"))).toEqual([]);
    expect(statuses().map((status) => status.media_ids)).toEqual([["remote-stored-1"]]);
  });
});

async function mediaBucket(id: string) {
  const [channel] = await rows(
    `SELECT c.provider_account_id AS account FROM app.operations o
       JOIN app.channels c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id WHERE o.id = $1`,
    [id],
  );
  const key = bucketKey({
    limitName: "media",
    scope: "account",
    keyName: "account",
    channel: { provider_id: manifest.id, provider_account_id: String(channel?.account), instance_host: HOST },
  });
  return () => rows("SELECT tokens FROM app.rate_buckets WHERE scope = 'account' AND key = $1", [key]);
}

// A secret in the forms a log line, a URL or a payload could carry it in.
const formsOf = (secret: string) => [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString("hex"),
  Buffer.from(secret).toString("base64"),
  JSON.stringify(secret).slice(1, -1),
];

describe("the log and the quota of a poll", () => {
  // SECURITY FLOOR
  it.each([
    ["a ready medium", undefined],
    ["a server error", 500],
    ["a rejection", 422],
  ] as const)("spends no media token and logs no media id, url or token (%s)", async (_arm, status) => {
    reset();
    const made = await processing();
    const bucket = await mediaBucket(made.id);
    const before = await bucket();
    expect(before).toHaveLength(1);
    if (status !== undefined) sim.arm("poll", { kind: "respond", status });
    await poll(capturing);
    expect(polls()).not.toHaveLength(0);
    expect(await bucket()).toEqual(before);
    const text = logged.join("\n");
    for (const secret of [made.media, made.token, HOST, "/api/v1/media"])
      for (const form of formsOf(secret)) expect(text).not.toContain(form);
  });
});

describe("the fencing of a poll", () => {
  // SECURITY FLOOR
  it("changes nothing when the lease is lost or the token is stale during the call", async () => {
    reset();
    const made = await processing();
    const commits = () =>
      rows(
        "SELECT count(*)::int AS n FROM app.operation_attempts WHERE operation_id = $1 AND step = 'commit'",
        [made.id],
      );
    onPoll = async () => {
      await rows(
        "UPDATE app.operations SET fencing_token = fencing_token + 1, lease_owner = 'other-poller' WHERE id = $1",
        [made.id],
      );
    };
    await poll();
    const after = (
      await rows("SELECT state, fencing_token::int AS token, lease_owner FROM app.operations WHERE id = $1", [
        made.id,
      ])
    )[0];
    expect(after).toMatchObject({ state: "processing", lease_owner: "other-poller" });
    expect(await commits()).toEqual([{ n: 0 }]);
    expect(statuses()).toEqual([]);
    expect(polls()).toHaveLength(1);
    const token = Number(after?.token);
    await poll();
    expect(Number((await opOf(made.id)).token)).toBe(token);
  });
});

describe("the tenant of a poll", () => {
  // SECURITY FLOOR
  it("reads and moves only the claimed operation of its own workspace, each with its own credential", async () => {
    reset();
    const other = await newWorkspace();
    const [a, b] = [await processing(), await processing(other)];
    await poll();
    for (const mine of [a, b]) {
      const requests = polls().filter((request) => request.path.endsWith(`/${mine.media}`));
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) expect(request.headers.authorization).toBe(`Bearer ${mine.token}`);
    }
    expect(await opOf(a.id)).toMatchObject({ state: "published" });
    expect(await opOf(b.id)).toMatchObject({ state: "published" });
    expect(
      statuses()
        .map((status) => status.media_ids?.[0])
        .sort(),
    ).toEqual([a.media, b.media].sort());
  });
});

const progressOf = async (id: string) =>
  (
    await rows(
      `SELECT state, effect, step_cursor, lease_owner, attempt_count,
         extract(epoch FROM next_check_at - clock_timestamp())::float8 AS check_in,
         extract(epoch FROM next_attempt_at - clock_timestamp())::float8 AS attempt_in,
         (SELECT count(*)::int FROM app.operation_attempts a WHERE a.operation_id = o.id AND a.step = 'commit') AS commits
       FROM app.operations o WHERE o.id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;

describe("media that become ready", () => {
  it("are polled again when the instance says 206, then the operation reaches the commit start and publishes once", async () => {
    reset({ processingPolls: 2 });
    const made = await processing();
    for (const step of [1, 2]) {
      await poll();
      expect(polls()).toHaveLength(step);
      expect(await progressOf(made.id)).toMatchObject({ state: "processing", lease_owner: null, commits: 0 });
      expect(Number((await progressOf(made.id)).check_in)).toBeGreaterThan(20);
      await due(made.id);
    }
    await poll();
    expect(await progressOf(made.id)).toMatchObject({
      state: "published",
      effect: "confirmed",
      step_cursor: "commit",
      attempt_count: 1,
      commits: 1,
    });
    expect(statuses().map((status) => status.media_ids)).toEqual([[made.media]]);
  });

  // [the quota of one send an hour, sends already counted in its window, the state the poll leaves, statuses sent, the
  // longest wait the manifest allows]: a full quota waits only as long as the manifest allows, though it frees later
  it.each([
    ["is free", 0, "published", 1, undefined],
    ["is full", 1, "retry_wait", 0, undefined],
    ["is full for an hour and the manifest allows 100 seconds", 1, "retry_wait", 0, 100],
  ] as const)("pass the commit start's quota check when it %s", async (_name, used, state, sent, cap) => {
    reset();
    const made = await processing();
    const [account] = await rows(
      `SELECT c.provider_account_id AS id, (SELECT a.id FROM app.operation_attempts a WHERE a.operation_id = o.id LIMIT 1) AS attempt
         FROM app.operations o JOIN app.channels c ON c.workspace_id = o.workspace_id AND c.id = o.channel_id WHERE o.id = $1`,
      [made.id],
    );
    if (used > 0)
      await rows(
        `INSERT INTO app.provider_quota_ledger (workspace_id, provider_id, provider_account_id, quota_key, operation_id, attempt_id, state)
         SELECT workspace_id, provider_id, $2, 'sends', id, $3, 'booked' FROM app.operations WHERE id = $1`,
        [made.id, account?.id, account?.attempt],
      );
    const quotas = [{ name: "sends", max: 1, windowSeconds: 3600 }];
    await poll(quiet, { quotas, ...(cap === undefined ? {} : { retryAfterMaxSeconds: cap }) });
    const after = await progressOf(made.id);
    expect(after).toMatchObject({ state, effect: state === "published" ? "confirmed" : "none" });
    if (cap !== undefined) expect(Number(after.attempt_in)).toBeLessThanOrEqual(cap);
    expect(statuses()).toHaveLength(sent);
  });
});

describe("the lateness of a poll", () => {
  it("never starts the commit when no lateness is left: retry_wait, and the sweep ends it missed", async () => {
    reset();
    const made = await processing();
    await rows("UPDATE app.operations SET lateness_deadline = now() - interval '1 second' WHERE id = $1", [
      made.id,
    ]);
    await poll();
    expect(await progressOf(made.id)).toMatchObject({ state: "retry_wait", effect: "none", commits: 0 });
    expect(statuses()).toEqual([]);
    await ledger("SELECT app.sweep_due_moves($1::jsonb)", [
      JSON.stringify({ [provider.providerId]: { max_attempts: 5 } }),
    ]);
    expect(await progressOf(made.id)).toMatchObject({ state: "missed", effect: "none", commits: 0 });
  });
});

describe("a processing operation that waits or ends", () => {
  // [attempts already used, the state a passed deadline leaves]: the provider is not asked
  it.each([
    [0, "retry_wait"],
    [5, "failed"],
  ] as const)(
    "with %i attempts used, a passed deadline leaves %s with no effect and no status",
    async (used, state) => {
      reset();
      const made = await processing();
      await rows(
        "UPDATE app.operations SET processing_deadline = now() - interval '1 second', attempt_count = $2 WHERE id = $1",
        [made.id, used],
      );
      await poll();
      expect(await progressOf(made.id)).toMatchObject({ state, effect: "none", commits: 0 });
      expect(polls()).toHaveLength(0);
      expect(statuses()).toEqual([]);
    },
  );

  it("counts each timeout as an attempt: three timeouts of three attempts end failed with no effect and no status", async () => {
    reset();
    const made = await processing();
    const live = JSON.stringify({ [provider.providerId]: { max_attempts: 3 } });
    for (const cycle of [1, 2, 3]) {
      await rows(
        "UPDATE app.operations SET processing_deadline = now() - interval '1 second' WHERE id = $1",
        [made.id],
      );
      await poll(quiet, { maxAttempts: 3 });
      if (cycle === 3) break;
      expect(await progressOf(made.id)).toMatchObject({ state: "retry_wait", attempt_count: cycle });
      await ledger("SELECT app.sweep_due_moves($1::jsonb)", [live]);
      for (let turns = 0; turns < 8 && (await progressOf(made.id)).state !== "processing"; turns++)
        await turn();
      await due(made.id);
    }
    expect(await progressOf(made.id)).toMatchObject({ state: "failed", effect: "none", commits: 0 });
    expect(statuses()).toEqual([]);
  });
});

describe("a poll the instance refuses with 401", () => {
  // [the instance forgot the token, so the grant is confirmed gone | the token still stands]: only a confirmed
  // revocation holds the row for a reconnect
  it.each([
    ["a revoked grant holds the row for a reconnect", true, "blocked_reconnect"],
    ["a grant that still stands only waits", false, "processing"],
  ] as const)("%s", async (_name, revoked, state) => {
    reset();
    const made = await processing();
    if (revoked) sim.reset();
    else sim.arm("poll", { kind: "respond", status: 401 });
    await poll();
    expect(await progressOf(made.id)).toMatchObject({ state, effect: "none", commits: 0 });
    if (state === "processing") expect(Number((await progressOf(made.id)).check_in)).toBeGreaterThan(20);
    expect(statuses()).toEqual([]);
  });
});

describe("a processing operation the provider rejects or keeps waiting", () => {
  it("a poll answered 422 is rejected: failed with no effect and no status", async () => {
    reset();
    const made = await processing();
    sim.arm("poll", { kind: "respond", status: 422 });
    await poll();
    expect(await progressOf(made.id)).toMatchObject({ state: "failed", effect: "none", commits: 0 });
    expect(statuses()).toEqual([]);
  });

  // [how the poll goes wrong]: the row keeps processing until its deadline, never failed or unknown
  it.each([
    ["a server error", async () => sim.arm("poll", { kind: "respond", status: 500 })],
    ["a 404 (an attached medium answers 404)", async () => sim.arm("poll", { kind: "respond", status: 404 })],
    [
      "a cut connection",
      async () => {
        onPoll = async () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        };
      },
    ],
    [
      "a channel that is disabled (nothing is polled)",
      (id: string) =>
        rows(
          `UPDATE app.channels c SET connection_state = 'disabled' FROM app.operations o
            WHERE o.id = $1 AND c.workspace_id = o.workspace_id AND c.id = o.channel_id`,
          [id],
        ),
    ],
  ] as const)("%s keeps it processing with a later check", async (_name, fault) => {
    reset();
    const made = await processing();
    await fault(made.id);
    await poll();
    expect(await progressOf(made.id)).toMatchObject({
      state: "processing",
      effect: "none",
      lease_owner: null,
    });
    expect(Number((await progressOf(made.id)).check_in)).toBeGreaterThan(20);
    expect(statuses()).toEqual([]);
  });
});
