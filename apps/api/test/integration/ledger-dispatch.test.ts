import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { describe, expect, it } from "vitest";
import {
  admin,
  called,
  type Env,
  holdFirst,
  isCommit,
  isPrepare,
  ledger,
  makeEnv,
  marked,
  opOf,
  type Plant,
  plant,
  READ_BACK_ONLY,
  recover,
  rows,
  sleep,
  takeBack,
  typesOf,
  useDispatchEnv,
} from "../support/ledger-dispatch-env.js";

useDispatchEnv();

// [crash, the call that is held (it never reaches the provider), what runs first, the plant, the state the sweep leaves]
type Crash = [
  string,
  ((url: string, method: string) => boolean) | undefined,
  "turn" | "resend" | "none",
  Plant,
  string,
];
const CRASHES: Crash[] = [
  ["claim", undefined, "none", {}, "pending"],
  ["prepare", isPrepare, "turn", {}, "pending"],
  ["after the marker, before the send", isCommit, "turn", {}, "unknown_external_state"],
  ["before the commit", undefined, "turn", {}, "pending"],
  ["after the commit, before the receipt", isCommit, "turn", {}, "unknown_external_state"],
  [
    "during the resend that follows a read-back",
    isCommit,
    "resend",
    { state: "unknown_external_state", effect: "possible", reconcile: true },
    "unknown_external_state",
  ],
];
describe("a crash at every step of a dispatch", () => {
  it.each(CRASHES)(
    "%s ends in a defined state with at most one create at the provider",
    async (name, match, first, planted, left) => {
      const hold = holdFirst(match ?? (() => false));
      let current = "";
      let ended = false;
      const e = await makeEnv({
        hold,
        before: async (route) => {
          // The lease ends once, while the provider is validating: the commit that follows is no longer the worker's.
          if (name !== "before the commit" || route !== "POST /v1/validate" || ended) return;
          ended = true;
          await takeBack(current);
        },
      });
      try {
        current = await plant(e, planted);
        if (planted.state !== undefined) await marked(current);
        if (name === "claim") {
          await ledger("SELECT * FROM app.claim_operations($1, 1, 'dead')", [e.queueName]);
          expect((await opOf(current)).state).toBe("claimed");
          await takeBack(current);
        } else {
          // The resend is the next publish turn after the tick's move back to retry (a second tick makes the row due).
          if (first === "resend") {
            await e.tick();
            await e.tick();
          }
          const running = e.turn();
          if (match) {
            await called(hold);
            await takeBack(current, e.sweepNow);
          }
          await running;
        }
        expect((await opOf(current)).state).toBe(left);
        hold.release();
        await recover(e, current);
        expect(await opOf(current)).toMatchObject({ state: "published", effect: "confirmed" });
        expect(e.sim.effects()).toBe(1);
        expect(e.sim.stored().length).toBe(1);
        if (first === "resend") {
          // Each commit has its own marker and raised the attempt count: the planted one, the held one and the resend.
          const [marks] = await rows(
            `SELECT count(*)::int AS n, count(effect_started_at)::int AS marked FROM app.operation_attempts
              WHERE operation_id = $1 AND step = 'commit'`,
            [current],
          );
          expect(marks).toEqual({ n: 3, marked: 3 });
          expect(await opOf(current)).toMatchObject({ attempt_count: 2 });
        }
      } finally {
        hold.release();
        await e.close();
      }
    },
    90_000,
  );
});

// [what changed at the provider's side of the target between the timeout and the resend, the state the turn leaves]
const GONE: [string, string, string][] = [
  [
    "the post was archived",
    `UPDATE app.posts p SET status = 'archived' FROM app.post_variants v JOIN app.operations o ON o.variant_id = v.id
      WHERE v.post_id = p.id AND o.id = $1`,
    "failed",
  ],
  [
    "the channel was disabled",
    `UPDATE app.channels c SET connection_state = 'disabled' FROM app.operations o
      WHERE o.channel_id = c.id AND o.id = $1`,
    "paused",
  ],
];
describe("a resend after an unknown outcome", () => {
  it.each(GONE)(
    "is never sent when %s in between",
    async (_name, change, after) => {
      const e = await makeEnv();
      try {
        const id = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
        await marked(id);
        await e.tick();
        expect(await opOf(id)).toMatchObject({ state: "retry_wait", effect: "none", queue: e.queueName });
        await rows(change, [id]);
        await e.tick();
        await e.turn();
        expect((await opOf(id)).state).toBe(after);
        expect(e.commits.count).toBe(0);
        expect(e.sim.effects()).toBe(0);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

// [case, the channel and the operation afterwards, the planted operation, the provider's answer to the credential check]
const REVOKED: [string, string, string, Plant, number][] = [
  ["a send refused 401, the check confirms", "needs_reconnect", "blocked_reconnect", {}, 401],
  ["a send refused 401, the check answers 503", "connected", "retry_wait", {}, 503],
  [
    "a read-back refused 401, the check confirms",
    "needs_reconnect",
    "blocked_reconnect",
    { state: "unknown_external_state", effect: "possible", reconcile: true },
    401,
  ],
  // The revocation cannot move a channel disabled meanwhile, so the row is read back again later.
  [
    "a read-back refused 401 on a disabled channel, the check confirms",
    "disabled",
    "unknown_external_state",
    { state: "unknown_external_state", effect: "possible", reconcile: true },
    401,
  ],
];
describe("a revoked grant (floor)", () => {
  it.each(REVOKED)(
    "%s: the channel is %s and the operation %s, never failed",
    async (_name, channelState, opState, planted, check) => {
      const e = await makeEnv();
      try {
        const id = await plant(e, planted);
        e.sim.armAccount({ kind: "respond", status: check });
        if (channelState === "disabled")
          await rows(
            "UPDATE app.channels c SET connection_state = 'disabled', disabled_from_state = 'connected' FROM app.operations o WHERE o.channel_id = c.id AND o.id = $1",
            [id],
          );
        if (planted.reconcile) {
          await marked(id, "post-77");
          e.sim.arm("readBack", { kind: "respond", status: 401 });
          await e.tick();
        } else {
          e.sim.arm("commit", { kind: "respond", status: 401 });
          await e.turn();
          expect(await opOf(id)).toMatchObject({ state: "retry_wait", effect: "none" });
          if (channelState !== "connected") {
            await rows("UPDATE app.operations SET next_attempt_at = now() WHERE id = $1", [id]);
            await e.tick();
            await e.turn();
          }
        }
        const [channel] = await rows(
          "SELECT c.connection_state, c.state_reason FROM app.channels c JOIN app.operations o ON o.channel_id = c.id WHERE o.id = $1",
          [id],
        );
        expect(channel).toEqual({
          connection_state: channelState,
          state_reason: channelState === "needs_reconnect" ? "revoked_confirmed" : null,
        });
        expect((await opOf(id)).state).toBe(opState);
        expect(e.sim.effects()).toBe(0);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

describe("an absence read before a resend", () => {
  it("does not count for the cycle after it: the old id is not read again", async () => {
    const e = await makeEnv({
      manifest: {
        readBackGapSeconds: 1,
        idempotency: { ...fixtureManifest.idempotency, keyWindowSeconds: 100 },
      },
    });
    try {
      const id = await plant(e, { state: "unknown_external_state", effect: "possible", reconcile: true });
      await marked(id, "gone-1", 120);
      await e.tick();
      await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
      await sleep(1_200);
      await e.tick();
      expect(await opOf(id)).toMatchObject({ state: "retry_wait", effect: "none" });
      await e.tick();
      e.sim.arm("commit", { kind: "hang" });
      await e.turn();
      expect(await opOf(id)).toMatchObject({ state: "unknown_external_state", effect: "possible" });
      await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
      await e.tick();
      // The resend holds no id of its own, so it goes to a person instead of waiting for a read-back nothing can make.
      expect(await opOf(id)).toMatchObject({
        state: "needs_human",
        effect: "possible",
        reason_code: "no_remote_id",
      });
      const [reads] = await rows(
        `SELECT count(*)::int AS n FROM app.operation_attempts a
          WHERE a.operation_id = $1 AND a.step = 'read_back'
            AND a.attempt_no > (SELECT max(attempt_no) FROM app.operation_attempts WHERE operation_id = $1 AND step = 'commit')`,
        [id],
      );
      expect(reads?.n).toBe(0);
    } finally {
      await e.close();
    }
  }, 40_000);
});

describe("the effect marker", () => {
  it("is committed and visible from a second session when the simulator receives the commit", async () => {
    let seen: Record<string, unknown> | undefined;
    let id = "";
    const e = await makeEnv({
      before: async (route) => {
        if (route !== "POST /v1/posts") return;
        seen = (
          await rows(
            `SELECT o.state, o.effect, a.step, a.effect AS attempt_effect, a.effect_started_at IS NOT NULL AS marked,
               a.finished_at IS NULL AS open, o.attempt_count
             FROM app.operations o JOIN app.operation_attempts a ON a.operation_id = o.id
             WHERE o.id = $1 AND a.step = 'commit'`,
            [id],
          )
        )[0];
      },
    });
    try {
      id = await plant(e);
      await e.turn();
      expect(seen).toEqual({
        state: "dispatching",
        effect: "possible",
        step: "commit",
        attempt_effect: "possible",
        marked: true,
        open: true,
        attempt_count: 1,
      });
      expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed", open: 0 });
    } finally {
      await e.close();
    }
  });
});

// [provider, manifest, the state the next tick leaves, whether the first notice is stamped]
const UNKNOWN: [string, Record<string, unknown>, string, boolean][] = [
  [
    "a provider that reads back only: the answer was lost, so there is no id to read",
    READ_BACK_ONLY,
    "needs_human",
    true,
  ],
  ["a provider that cannot read back", { ...READ_BACK_ONLY, readBackMode: "E" }, "needs_human", true],
];
describe("a timeout after the send", () => {
  it.each(UNKNOWN)(
    "ends unknown with its horizon and is never resent: %s",
    async (_name, manifest, after, notice) => {
      const e = await makeEnv({ manifest });
      try {
        e.sim.arm("commit", { kind: "hang" });
        const id = await plant(e);
        await e.turn();
        expect(await opOf(id)).toMatchObject({
          state: "unknown_external_state",
          effect: "possible",
          queue: e.reconcileQueue,
          horizon: true,
          open: 0,
          attempt_count: 1,
        });
        expect(Number((await opOf(id)).horizon_in)).toBeGreaterThan(0);
        await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
        await e.tick();
        expect(e.commits.count).toBe(1);
        // A provider that cannot read back has no reason code to give.
        expect(await opOf(id)).toMatchObject({
          state: after,
          escalated: notice,
          reason_code: manifest.readBackMode === "E" ? null : "no_remote_id",
        });
        expect(await typesOf(id)).toContain(
          `operation.${after === "needs_human" ? "needs_human" : "reconciling"}`,
        );
        expect(await typesOf(id)).not.toContain("operation.retry_wait");
      } finally {
        await e.close();
      }
    },
    60_000,
  );
});

describe("the heartbeat of a dispatch", () => {
  it("keeps running from the claim through the call that was already sent", async () => {
    const hold = holdFirst(isCommit);
    const e = await makeEnv({ hold, lease: 24 });
    try {
      const id = await plant(e);
      const running = e.turn();
      await called(hold);
      const during = await opOf(id);
      expect(during.state).toBe("dispatching");
      await sleep(9_500);
      const later = await opOf(id);
      expect(new Date(later.heartbeat_at as string).getTime()).toBeGreaterThan(
        new Date(during.heartbeat_at as string).getTime(),
      );
      hold.release();
      await running;
      expect(await opOf(id)).toMatchObject({ state: "published", effect: "confirmed" });
    } finally {
      hold.release();
      await e.close();
    }
  }, 60_000);
});

// [how the lease is lost while the commit call is held]
const LOST: [string, (id: string, e: Env) => Promise<void>][] = [
  [
    "the token moves on",
    (id) =>
      admin(async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.job_purpose', 'claim_polls', true)");
        await client.query("UPDATE app.operations SET fencing_token = fencing_token + 1 WHERE id = $1", [id]);
        await client.query("COMMIT");
      }),
  ],
  ["the lease ends and the sweep takes the row", (id, e) => takeBack(id, e.sweepNow)],
];
describe("a lease lost during the call", () => {
  it.each(LOST)(
    "ends the turn lost with no later write: %s",
    async (_name, lose) => {
      const hold = holdFirst(isCommit);
      const e = await makeEnv({ hold, lease: 24 });
      try {
        const id = await plant(e);
        const running = e.turn();
        await called(hold);
        await lose(id, e);
        const before = await opOf(id);
        expect(await running).toMatchObject({ kind: "lost" });
        await sleep(600);
        // The horizon counts down by itself; every other column stays as the sweep left it.
        expect({ ...(await opOf(id)), horizon_in: 0 }).toEqual({ ...before, horizon_in: 0 });
        expect(e.sim.effects()).toBe(0);
      } finally {
        hold.release();
        await e.close();
      }
    },
    60_000,
  );
});
