import { createHash } from "node:crypto";
import type { ProviderAdapter } from "@shoutory/provider-sdk/adapter";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { describe, expect, it } from "vitest";
import { reconcileStep } from "../../src/jobs/ledger/reconcile.js";
import { createLedgerTick } from "../../src/jobs/ledger/tick.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { ledgerCredentials } from "../support/ledger-credentials.js";
import {
  admin,
  called,
  holdFirst,
  isCommit,
  logger,
  makeEnv,
  marked,
  opOf,
  type Plant,
  plant,
  queueOf,
  READ_BACK_ONLY,
  rows,
  sleep,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";
import { connectThrough, seedDueTarget } from "../support/ledger-seed.js";

useDispatchEnv();

const rateKey = async (id: string, providerId: string) => {
  const [row] = await rows(
    `SELECT c.provider_account_id AS account FROM app.channels c JOIN app.operations o ON o.channel_id = c.id
      WHERE o.id = $1`,
    [id],
  );
  return createHash("sha256")
    .update([providerId, "posts", "account", String(row?.account)].join("\0"))
    .digest("hex");
};

describe("a rate limit from the provider", () => {
  it("pauses the operation with a cooldown and the account's bucket with it", async () => {
    const e = await makeEnv();
    try {
      e.sim.arm("commit", { kind: "respond", status: 429, retryAfter: "5000" });
      const id = await plant(e);
      await e.turn();
      expect(await opOf(id)).toMatchObject({
        state: "paused",
        reason_code: "provider_cooldown",
        effect: "none",
      });
      const [bucket] = await rows(
        "SELECT paused_until > now() AS paused FROM app.rate_buckets WHERE scope = 'account' AND key = $1",
        [await rateKey(id, e.providerId)],
      );
      expect(bucket?.paused).toBe(true);
    } finally {
      await e.close();
    }
  }, 30_000);
});

// [the turn's providers, the plant, the log text, the reason the line carries]
const CANNOT: [string, "no adapter" | "adapter", Plant, string, string][] = [
  ["its provider has no adapter", "no adapter", {}, "has no adapter", "provider"],
  ["it has no frozen version", "adapter", { unfrozen: true }, "nothing to send", "no_frozen_version"],
  [
    "its frozen snapshot cannot be read",
    "adapter",
    { unreadable: true },
    "nothing to send",
    "frozen_snapshot_unreadable",
  ],
];
describe("a claimed row that cannot be sent", () => {
  it.each(CANNOT)(
    "fails before any call when %s, with one log line of ids and reason",
    async (_name, wiring, planted, text, reason) => {
      const e = await makeEnv();
      const lines: string[] = [];
      const own = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });
      try {
        const id = await plant(e, planted);
        const result = await runTurn({
          pool: workerPool(),
          logger: own,
          registry: e.registry,
          adapters: wiring === "adapter" ? e.adapters : {},
          fetchFor: e.fetchFor,
          credentials: e.credentials,
          queue: e.queueName,
          owner: "owner-w",
          closing: new AbortController().signal,
        });
        expect(result).toMatchObject({ kind: "moved", to: "failed", id });
        expect(await opOf(id)).toMatchObject({ state: "failed", attempts: 0 });
        expect(e.sim.effects()).toBe(0);
        const logged = lines.filter((line) => line.includes(text));
        expect(logged.length).toBe(1);
        expect(logged[0]).toContain(wiring === "adapter" ? id : e.providerId);
        expect(logged[0]).toContain(reason);
        expect(logged[0]).not.toContain("hello dispatch");
      } finally {
        await e.close();
      }
    },
  );
});

describe("the tick", () => {
  it("gives the lease sweep the manifest's horizon, so a row that became unknown is chased and not forgotten", async () => {
    const e = await makeEnv();
    try {
      const id = await plant(e, { state: "dispatching", effect: "possible", leased: true });
      await e.tick();
      const row = await opOf(id);
      expect(row).toMatchObject({ state: "unknown_external_state", queue: e.reconcileQueue, horizon: true });
      expect(Number(row.horizon_in)).toBeGreaterThan(29 * 86_400);
    } finally {
      await e.close();
    }
  });

  it("reads one unknown outcome back by its id and publishes it on read-back evidence, with no resend", async () => {
    const e = await makeEnv();
    try {
      const made = await fetch(`${e.sim.url}/v1/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello dispatch" }),
      });
      const { id: externalId } = (await made.json()) as { id: string };
      const id = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
      await marked(id, externalId, 120);
      await e.tick();
      expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed" });
      const evidence = await rows(
        "SELECT kind, level, external_id FROM app.operation_evidence WHERE operation_id = $1",
        [id],
      );
      expect(evidence).toEqual([{ kind: "verified", level: "read_back", external_id: externalId }]);
      expect(e.sim.effects()).toBe(1);
    } finally {
      await e.close();
    }
  });
});

describe("the tick and an unknown outcome that cannot be read", () => {
  it("ends an unknown outcome past its horizon unverified, without a call", async () => {
    const e = await makeEnv();
    try {
      const id = await plant(e, {
        state: "unknown_external_state",
        effect: "possible",
        reconcile: true,
        horizonEndedAgo: 10,
      });
      await e.tick();
      expect(await opOf(id)).toMatchObject({ state: "unverified", effect: "possible", attempts: 0 });
      expect(e.commits.count).toBe(0);
    } finally {
      await e.close();
    }
  });

  it("claims no unknown outcome to read back once the worker is closing", async () => {
    const e = await makeEnv();
    try {
      const id = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
      await marked(id, "gone-1", 120);
      const closing = new AbortController();
      closing.abort();
      await reconcileStep({
        pool: workerPool(),
        logger: createLogger({ secrets: [], stream: { write: () => undefined } }),
        registry: e.registry,
        adapters: e.adapters,
        fetchFor: e.fetchFor,
        credentials: e.credentials,
        owner: "tick-closing",
        closing: closing.signal,
      });
      expect(await opOf(id)).toMatchObject({ state: "unknown_external_state", token: 1 });
    } finally {
      await e.close();
    }
  });
});

describe("an absence read back twice", () => {
  // [the manifest, the state after, whether the move back to retry carries the proof of absence]
  const ROWS: [string, Record<string, unknown>, string, boolean][] = [
    [
      "goes back to retry on the publish queue with absent evidence",
      { readBackGapSeconds: 1 },
      "retry_wait",
      true,
    ],
    [
      "goes to a person when the manifest forbids a resend",
      { ...READ_BACK_ONLY, readBackGapSeconds: 1 },
      "needs_human",
      false,
    ],
  ];
  it.each(ROWS)(
    "%s",
    async (_name, manifest, after, proven) => {
      const e = await makeEnv({ manifest });
      try {
        const id = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
        await marked(id, "gone-1", 120);
        await e.tick();
        expect(await opOf(id)).toMatchObject({ state: "unknown_external_state", effect: "possible" });
        await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
        await sleep(1_200);
        await e.tick();
        expect(await opOf(id)).toMatchObject({ state: after, effect: proven ? "none" : "possible" });
        const proof = await rows("SELECT kind FROM app.operation_evidence WHERE operation_id = $1", [id]);
        expect(proof).toEqual(proven ? [{ kind: "absent" }] : []);
        expect(e.commits.count).toBe(0);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

describe("the read-back loop of the tick", () => {
  it("a read-back that hangs does not delay the sweeps and admission of the same tick", async () => {
    const hold = holdFirst((url, method) => method === "GET" && url.includes("/v1/posts/"));
    const e = await makeEnv({ lease: 60, hold });
    const loop = createLedgerTick({
      pool: workerPool(),
      boss: queueOf(),
      registry: e.registry,
      logger,
      adapters: e.adapters,
      fetchFor: e.fetchFor,
      credentials: e.credentials,
      intervalMs: 100,
    });
    try {
      connectThrough(workerPool());
      await queueOf().createQueue(e.queueName, { policy: "short", retryLimit: 0 });
      const stuck = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
      await marked(stuck, "hang-1", 120);
      loop.start();
      await called(hold);
      const [home] = await rows("SELECT id FROM app.workspaces LIMIT 1");
      const target = await admin((client) => seedDueTarget(client, String(home?.id), 30, e.providerId));
      const admitted = async () =>
        (await rows("SELECT id FROM app.operations WHERE variant_id = $1", [target])).length;
      for (let tries = 0; tries < 50 && (await admitted()) === 0; tries++) await sleep(100);
      expect(await admitted()).toBe(1);
    } finally {
      hold.release();
      await loop.stop();
      await e.close();
    }
  }, 30_000);
});

describe("a read-back that hangs in one provider", () => {
  it("does not delay the read-back of another provider's row", async () => {
    const hold = holdFirst((url, method) => method === "GET" && url.includes("/v1/posts/"));
    const [first, second] = [await makeEnv({ lease: 60, hold }), await makeEnv()];
    let step: Promise<void> = Promise.resolve();
    try {
      const registry = createRegistry([...first.registry.manifests, ...second.registry.manifests]);
      const adapters: Record<string, ProviderAdapter> = {
        [first.providerId]: first.adapters[first.providerId] as ProviderAdapter,
        [second.providerId]: second.adapters[second.providerId] as ProviderAdapter,
      };
      const planted = { state: "unknown_external_state", effect: "possible", reconcile: true } as const;
      await marked(await plant(first, planted), "hang-1", 120);
      const fine = await plant(second, planted);
      await marked(fine);
      step = reconcileStep({
        pool: workerPool(),
        logger,
        registry,
        adapters,
        fetchFor: first.fetchFor,
        credentials: ledgerCredentials(workerPool(), { registry, adapters, fetchFor: first.fetchFor }),
        owner: "tick-hang",
        closing: new AbortController().signal,
      });
      await called(hold);
      for (let tries = 0; tries < 50 && (await opOf(fine)).state !== "retry_wait"; tries++) await sleep(100);
      expect(await opOf(fine)).toMatchObject({ state: "retry_wait" });
    } finally {
      hold.release();
      await step;
      await first.close();
      await second.close();
    }
  }, 30_000);
});

describe("a failing read-back", () => {
  // [how the adapter fails]
  const FAILS: [string, () => Promise<never>][] = [
    [
      "throws",
      () => {
        throw new Error("canary-readback-boom");
      },
    ],
    ["rejects", () => Promise.reject(new Error("canary-readback-boom"))],
  ];
  it.each(FAILS)(
    "a throwing adapter in one provider's read-back does not stop another provider's row: it %s",
    async (_name, fail) => {
      const [first, second] = [await makeEnv(), await makeEnv()];
      const lines: string[] = [];
      try {
        const registry = createRegistry([...first.registry.manifests, ...second.registry.manifests]);
        const adapters: Record<string, ProviderAdapter> = {
          [first.providerId]: { ...first.adapters[first.providerId], readBack: fail } as ProviderAdapter,
          [second.providerId]: second.adapters[second.providerId] as ProviderAdapter,
        };
        const bad = await plant(first, {
          state: "unknown_external_state",
          effect: "possible",
          reconcile: true,
        });
        await marked(bad, "throws-1", 120);
        const fine = await plant(second, {
          state: "unknown_external_state",
          effect: "possible",
          reconcile: true,
        });
        await marked(fine);
        await reconcileStep({
          pool: workerPool(),
          logger: createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } }),
          registry,
          adapters,
          fetchFor: first.fetchFor,
          credentials: ledgerCredentials(workerPool(), { registry, adapters, fetchFor: first.fetchFor }),
          owner: "tick-isolation",
          closing: new AbortController().signal,
        });
        // The other provider's row was reached, and the failing row was neither failed nor resent.
        expect(await opOf(fine)).toMatchObject({ state: "retry_wait", effect: "none" });
        expect(["reconciling", "unknown_external_state"]).toContain((await opOf(bad)).state);
        expect([first.commits.count, second.commits.count, first.sim.effects()]).toEqual([0, 0, 0]);
        const logged = lines.filter((line) => line.includes(bad));
        expect(logged.length).toBeGreaterThan(0);
        expect(logged.some((line) => line.includes(first.providerId))).toBe(true);
        expect(lines.join("\n")).not.toContain("canary-readback-boom");
      } finally {
        await first.close();
        await second.close();
      }
    },
    30_000,
  );
});

describe("a provider error body", () => {
  // [the status the provider answers with]
  it.each([[500], [422], [429]])(
    "a provider error body canary is absent from every log line and from the stored attempt (status %s)",
    async (status) => {
      const e = await makeEnv();
      const lines: string[] = [];
      const canaryFetch: typeof fetch = async (input, init) =>
        isCommit(String(input), init?.method ?? "GET")
          ? new Response(`{"error":{"code":"canary-body-code","message":"canary-error-body-0001"}}`, {
              status: Number(status),
            })
          : fetch(input, init);
      try {
        const id = await plant(e);
        await runTurn({
          pool: workerPool(),
          logger: createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } }),
          registry: e.registry,
          adapters: e.adapters,
          fetchFor: () => canaryFetch,
          credentials: ledgerCredentials(workerPool(), {
            registry: e.registry,
            adapters: e.adapters,
            fetchFor: () => canaryFetch,
          }),
          queue: e.queueName,
          owner: "owner-body",
          closing: new AbortController().signal,
        });
        const [attempt] = await rows(
          "SELECT row_to_json(a)::text AS stored FROM app.operation_attempts a WHERE operation_id = $1",
          [id],
        );
        expect(attempt?.stored).toBeDefined();
        expect(String(attempt?.stored)).not.toContain("canary-error-body-0001");
        expect(lines.join("\n")).not.toContain("canary-error-body-0001");
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

describe("the worker's clock reaches the adapter", () => {
  const AT = new Date("2026-11-26T10:00:00.000Z");
  const seen = (ctx: { now: () => Date }) => ({
    ok: true,
    effect: "confirmed" as const,
    externalId: `clock-${ctx.now().toISOString()}`,
  });
  const externalIdOf = async (id: string) =>
    (await rows("SELECT external_id FROM app.operations WHERE id = $1", [id]))[0]?.external_id;

  type Env = Awaited<ReturnType<typeof makeEnv>>;
  // [path, the env options, the operation to plant, the call that runs the adapter once]
  const PATHS: [
    string,
    () => Parameters<typeof makeEnv>,
    Parameters<typeof plant>[1],
    (e: Env) => Promise<unknown>,
  ][] = [
    ["turn", () => [{ clock: () => AT }], undefined, (e) => e.turn()],
    [
      "read-back",
      () => [],
      { state: "unknown_external_state", effect: "possible", reconcile: true },
      (e) =>
        reconcileStep({
          pool: workerPool(),
          logger,
          registry: e.registry,
          adapters: e.adapters,
          fetchFor: e.fetchFor,
          credentials: e.credentials,
          owner: "tick-clock",
          closing: new AbortController().signal,
          clock: () => AT,
        }),
    ],
  ];
  it.each(PATHS)(
    "the adapter context clock is the clock of the %s",
    async (path, options, planted, run) => {
      const e = await makeEnv(...options());
      try {
        e.adapters[e.providerId] = {
          ...e.adapters[e.providerId],
          commit: async (ctx) => seen(ctx),
          readBack: async (ctx) => seen(ctx),
        } as ProviderAdapter;
        const id = await plant(e, planted);
        if (path === "read-back") await marked(id, "clock-1", 120);
        await run(e);
        expect(await externalIdOf(id)).toBe(`clock-${AT.toISOString()}`);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

// A send of an earlier operation `ago` seconds back, booked against the account of the target's channel.
const spend = (o: {
  earlier: string;
  target: string;
  provider: string;
  key: string;
  ago: number;
  number: number;
}) =>
  rows(
    `WITH attempt AS (
       INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token,
         effect_started_at, effect)
       SELECT workspace_id, id, $6::int, 'commit', 1, now(), 'possible' FROM app.operations WHERE id = $1
       RETURNING id, workspace_id)
     INSERT INTO app.provider_quota_ledger (workspace_id, provider_id, provider_account_id, quota_key,
       operation_id, attempt_id, at)
     SELECT a.workspace_id, $2, c.provider_account_id, $3, $1, a.id, now() - make_interval(secs => $4)
       FROM attempt a, app.operations o JOIN app.channels c ON c.id = o.channel_id WHERE o.id = $5`,
    [o.earlier, o.provider, o.key, o.ago, o.target, o.number],
  );

// [the quota keys with the age of their earlier send in seconds, window seconds each, retry-after max, seconds of
// lateness left, the state, the reason code, the wait window in seconds]
const ROWS: [string, [string, number][], number, number, number, string, string | null, [number, number]][] =
  [
    ["the slot frees within the limits", [["posts", 120]], 300, 900, 7200, "retry_wait", null, [170, 181]],
    [
      "two keys: the later window decides",
      [
        ["posts", 280],
        ["slow", 100],
      ],
      600,
      900,
      7200,
      "retry_wait",
      null,
      [490, 501],
    ],
    [
      "the slot frees after the retry-after maximum",
      [["posts", 60]],
      300,
      100,
      7200,
      "paused",
      "provider_cooldown",
      [230, 241],
    ],
    [
      "the slot frees after the lateness left",
      [["posts", 60]],
      300,
      900,
      100,
      "paused",
      "provider_cooldown",
      [230, 241],
    ],
  ];
describe("a quota denial", () => {
  it.each(ROWS)(
    "quota denial: retry_wait when the freed slot is within retry-after-max and lateness, else paused provider_cooldown at the window time: %s",
    async (_name, keys, window, retryMax, lateness, state, reason, [low, high]) => {
      const e = await makeEnv({
        manifest: {
          quotas: keys.map(([name]) => ({ name, max: 1, windowSeconds: window })),
          retryAfterMaxSeconds: retryMax,
        },
      });
      try {
        const id = await plant(e);
        await rows(
          "UPDATE app.operations SET lateness_deadline = now() + make_interval(secs => $2) WHERE id = $1",
          [id, lateness],
        );
        const earlier = await plant(e, { state: "published", effect: "confirmed" });
        for (const [number, [key, ago]] of keys.entries())
          await spend({ earlier, target: id, provider: e.providerId, key, ago, number: number + 1 });
        await e.turn();
        const [row] = await rows(
          `SELECT state, reason_code, extract(epoch FROM next_attempt_at - clock_timestamp())::float8 AS wait
             FROM app.operations WHERE id = $1`,
          [id],
        );
        expect(row).toMatchObject({ state, reason_code: reason });
        expect(Number(row?.wait)).toBeGreaterThan(low);
        expect(Number(row?.wait)).toBeLessThan(high);
        expect(e.commits.count).toBe(0);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});
