import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcileStep } from "../../src/jobs/ledger/reconcile.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { ledgerKeys } from "../support/ledger-credentials.js";
import {
  makeEnv,
  marked,
  opOf,
  type Plant,
  plant,
  READ_BACK_ONLY,
  rows,
  sleep,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";

// Feature rows of the dispatch: what a result of the provider does to the account's bucket, what a row that cannot be sent
// does, and what the tick does with the sweeps and with an unknown outcome. The decisions themselves (result to move,
// resend by class and window, the absence rule) are the unit tables of core; these rows prove only what the database and
// the worker do with them. The environment of the rows is `support/ledger-dispatch-env.ts`.
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
    // fails first because: the 429 moves the row but leaves the bucket open, so the next post of the account goes out at once
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
      // fails first because: the row stays leased, the text comes from the mutable variant, or the turn calls with nothing to send
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
          keys: ledgerKeys,
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
    // fails first because: the sweep gets no arguments, so the row has no unverified horizon and is due on the default back-off
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
    // fails first because: the tick never reads an unknown outcome back, or sends the post again instead
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
    // fails first because: the due-move sweep gets no live providers, so the row is chased for ever
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
    // fails first because: the reconcile step takes its batch of leases before it looks at the closing signal
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
        keys: ledgerKeys,
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
      // fails first because: one absent read is enough, or a provider that forbids a resend gets one
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
