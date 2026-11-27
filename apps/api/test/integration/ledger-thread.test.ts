import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { describe, expect, it } from "vitest";
import {
  type Env,
  makeEnv as makeBareEnv,
  opOf,
  queueOf,
  requestDelete,
  rows,
  scheduleThread,
  type ThreadPart,
  useDispatchEnv,
} from "../support/ledger-dispatch-env.js";

useDispatchEnv();

// The tick wakes the provider's publish queue, so the queue has to exist.
async function makeEnv(options: Parameters<typeof makeBareEnv>[0] = {}): Promise<Env> {
  const e = await makeBareEnv(options);
  await queueOf().createQueue(e.queueName, { policy: "short", retryLimit: 0 });
  return e;
}

const NO_READ = {
  readBackMode: "E",
  idempotency: { ...fixtureManifest.idempotency, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "never", readBack: "safe", edit: "never", delete: "never" },
};
const gone = { kind: "respond", status: 500, afterEffect: true } as const;
const refused = { kind: "respond", status: 403 } as const;

const reply = (n: number): ThreadPart => ({ kind: "thread_reply", text: `part ${n}` });
const comment = (n: number): ThreadPart => ({ kind: "first_comment", text: `part ${n}` });

const publishOps = (variant: string) =>
  rows(
    `SELECT id, part_index, state, external_id FROM app.operations WHERE variant_id = $1 AND kind = 'publish'
     ORDER BY part_index, created_at`,
    [variant],
  );
const deleteOps = (variant: string) =>
  rows(
    "SELECT id, part_index, state FROM app.operations WHERE variant_id = $1 AND kind = 'delete' ORDER BY part_index DESC",
    [variant],
  );
const shown = async (variant: string) =>
  (
    await rows(
      `SELECT v.schedule_state, v.external_id, v.presence, p.status, p.targets_total, p.targets_published,
         p.targets_published_not_live
       FROM app.post_variants v JOIN app.posts p ON p.workspace_id = v.workspace_id AND p.id = v.post_id
       WHERE v.id = $1`,
      [variant],
    )
  )[0] as Record<string, unknown>;

// One admission and one turn: the root first, then each part as the one before it is published.
async function step(e: Env): Promise<unknown> {
  await e.tick();
  return e.turn();
}
async function publishParts(e: Env, variant: string, count: number): Promise<void> {
  for (let n = 0; n < count; n++) {
    expect(await step(e)).toMatchObject({ kind: "dispatched", to: "published" });
    expect((await publishOps(variant))[n]).toMatchObject({ part_index: n, state: "published" });
  }
}
async function unknownThenPerson(e: Env, id: string): Promise<void> {
  for (let round = 0; round < 4 && (await opOf(id)).state !== "needs_human"; round++) {
    await rows("UPDATE app.operations SET next_check_at = now(), next_attempt_at = now() WHERE id = $1", [
      id,
    ]);
    await e.tick();
  }
}

describe("a thread publishes part by part (floor)", () => {
  it.each([
    ["a thread of replies", [reply(1), reply(2)], [0, 1]],
    ["a first comment", [comment(1)], [0]],
    ["a reply and a first comment", [reply(1), comment(2)], [0, 0]],
  ] as const)(
    "%s: in order, each naming its parent's remote id",
    async (_name, parts, parents) => {
      const e = await makeEnv();
      try {
        const { variant } = await scheduleThread(e, parts);
        await publishParts(e, variant, parts.length + 1);
        const made = await publishOps(variant);
        const stored = e.sim.stored();
        parts.forEach((part, i) => {
          const post = stored.find((one) => one.text === part.text);
          expect(post?.replyToExternalId).toBe(made[parents[i] as number]?.external_id);
        });
        expect(stored.find((one) => one.text === "hello dispatch")?.replyToExternalId).toBeUndefined();
        expect(await e.tick()).toBeUndefined();
        expect(await publishOps(variant)).toHaveLength(parts.length + 1);
        expect(e.commits.count).toBe(parts.length + 1);
      } finally {
        await e.close();
      }
    },
    60_000,
  );

  it("keeps the variant in progress and the post unpublished between parts, and settles both after the last", async () => {
    const e = await makeEnv();
    try {
      const { variant } = await scheduleThread(e, [reply(1), reply(2)]);
      await publishParts(e, variant, 1);
      expect(await shown(variant)).toMatchObject({ schedule_state: "in_progress", targets_published: 0 });
      expect((await shown(variant)).status).not.toBe("published");
      await e.tick();
      expect(await e.turn()).toMatchObject({ to: "published" });
      expect(await shown(variant)).toMatchObject({ schedule_state: "in_progress" });
      await e.tick();
      expect(await e.turn()).toMatchObject({ to: "published" });
      const root = (await publishOps(variant))[0]?.external_id;
      expect(await shown(variant)).toMatchObject({
        schedule_state: "settled",
        status: "published",
        external_id: root,
        targets_total: 1,
        targets_published: 1,
      });
    } finally {
      await e.close();
    }
  }, 60_000);
});

describe("a part that does not publish (floor)", () => {
  it.each([
    ["a reply of a thread", [reply(1), reply(2)], 1],
    ["the last reply of a thread", [reply(1), reply(2)], 2],
    ["a first comment", [comment(1)], 1],
  ] as const)(
    "%s fails: the post is partially published and the variant keeps the root's id",
    async (_name, parts, at) => {
      const e = await makeEnv();
      try {
        const { variant } = await scheduleThread(e, parts);
        await publishParts(e, variant, at);
        e.sim.arm("commit", refused);
        await e.tick();
        expect(await e.turn()).toMatchObject({ kind: "dispatched", to: "failed" });
        const root = (await publishOps(variant))[0]?.external_id;
        expect(await shown(variant)).toMatchObject({
          schedule_state: "settled",
          status: "partially_published",
          external_id: root,
          targets_total: 1,
          targets_published: 1,
        });
        await e.tick();
        expect(await publishOps(variant)).toHaveLength(at + 1);
      } finally {
        await e.close();
      }
    },
    60_000,
  );

  it("never counts a live root as failed or as removed from the provider", async () => {
    const e = await makeEnv();
    try {
      const { variant } = await scheduleThread(e, [reply(1)]);
      await publishParts(e, variant, 1);
      expect(await shown(variant)).toMatchObject({
        schedule_state: "in_progress",
        status: "scheduled",
        targets_total: 1,
        targets_published: 0,
        targets_published_not_live: 0,
      });
      await e.tick();
      expect(await e.turn()).toMatchObject({ to: "published" });
      expect(await shown(variant)).toMatchObject({ status: "published", targets_published_not_live: 0 });
    } finally {
      await e.close();
    }
  }, 60_000);
});

async function published(e: Env, parts: number) {
  const { variant } = await scheduleThread(
    e,
    Array.from({ length: parts - 1 }, (_, i) => reply(i + 1)),
  );
  await publishParts(e, variant, parts);
  const ids = (await publishOps(variant)).map((op) => String(op.external_id));
  return { variant, ids };
}
const remaining = (e: Env) => e.sim.stored().map((one) => one.externalId);

describe("the delete of a thread (floor)", () => {
  it("removes every published part, the last first and each once, and shows the post removed only after the root", async () => {
    const e = await makeEnv();
    try {
      const { variant, ids } = await published(e, 3);
      await requestDelete(e, variant);
      const order: string[][] = [];
      for (let n = 0; n < 3; n++) {
        await e.tick();
        expect(await e.turn()).toMatchObject({ kind: "dispatched", to: "published" });
        order.push(remaining(e));
        if (n < 2) expect((await shown(variant)).presence).toBe("removal_pending");
      }
      expect(order).toEqual([[ids[0], ids[1]], [ids[0]], []]);
      expect((await shown(variant)).presence).toBe("removed_at_provider");
      await e.tick();
      expect(await e.turn()).toMatchObject({ kind: "idle" });
      expect((await deleteOps(variant)).map((op) => [op.part_index, op.state])).toEqual([
        [2, "published"],
        [1, "published"],
        [0, "published"],
      ]);
    } finally {
      await e.close();
    }
  }, 60_000);
});

describe("the delete chain of a thread that stops or is partial (floor)", () => {
  it("of a partially published thread removes only the published parts and never calls the provider for a part with no remote id", async () => {
    const deletes: string[] = [];
    const e = await makeEnv({
      before: (route) => {
        if (route.startsWith("DELETE")) deletes.push(route);
      },
    });
    try {
      const { variant } = await scheduleThread(e, [reply(1), reply(2)]);
      await publishParts(e, variant, 2);
      e.sim.arm("commit", refused);
      await e.tick();
      expect(await e.turn()).toMatchObject({ to: "failed" });
      await requestDelete(e, variant);
      for (let n = 0; n < 2; n++) {
        await e.tick();
        expect(await e.turn()).toMatchObject({ kind: "dispatched", to: "published" });
      }
      await e.tick();
      expect(await e.turn()).toMatchObject({ kind: "idle" });
      expect(deletes).toHaveLength(2);
      expect((await deleteOps(variant)).map((op) => [op.part_index, op.state])).toEqual([
        [1, "published"],
        [0, "published"],
      ]);
      expect(remaining(e)).toEqual([]);
      expect((await shown(variant)).presence).toBe("removed_at_provider");
    } finally {
      await e.close();
    }
  }, 60_000);
});

describe("a delete chain that stops (floor)", () => {
  it.each([
    ["is unknown and goes to a person", gone, NO_READ],
    ["fails", refused, {}],
  ] as const)(
    "stops when the delete of a part %s: nothing further is sent and the post shows removal_unknown",
    async (_name, fault, manifest) => {
      const e = await makeEnv({ manifest });
      try {
        const { variant, ids } = await published(e, 3);
        await requestDelete(e, variant);
        await e.tick();
        await e.turn();
        await e.tick();
        e.sim.arm("delete", fault);
        await e.turn();
        const second = (await deleteOps(variant)).find((op) => op.part_index === 1);
        if (fault === gone) await unknownThenPerson(e, String(second?.id));
        await e.tick();
        await e.tick();
        expect(await e.turn()).toMatchObject({ kind: "idle" });
        expect((await deleteOps(variant)).map((op) => op.part_index)).toEqual([2, 1]);
        expect((await shown(variant)).presence).toBe("removal_unknown");
        expect(remaining(e)).toContain(ids[0]);
      } finally {
        await e.close();
      }
    },
    60_000,
  );
});
