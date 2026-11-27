import { describe, expect, it } from "vitest";
import { makeEnv, plant, rows, useDispatchEnv } from "../support/ledger-dispatch-env.js";

useDispatchEnv();

const shown = async (id: string) =>
  (
    await rows(
      `SELECT v.presence, p.targets_published_not_live AS k, v.external_id, v.permalink, v.published_at IS NOT NULL AS dated,
              p.status
         FROM app.operations o JOIN app.post_variants v ON v.id = o.variant_id JOIN app.posts p ON p.id = v.post_id
        WHERE o.id = $1`,
      [id],
    )
  )[0] as Record<string, unknown>;

const move = (id: string, to: string, actor: string) =>
  rows(
    "UPDATE app.operations SET state = $2, last_actor = $3, effect = CASE WHEN $2 = 'failed' THEN 'none' ELSE effect END WHERE id = $1",
    [id, to, actor],
  );

// The recorded answer that proves a failed send had no effect.
const noEffect = (id: string) =>
  rows(
    `INSERT INTO app.operation_attempts (workspace_id, operation_id, attempt_no, step, fencing_token, effect_started_at, effect, finished_at)
     SELECT workspace_id, id, 1, 'commit', 1, now(), 'none', now() FROM app.operations WHERE id = $1`,
    [id],
  );

const action = (presence: string) => ({ kind: "delete", externalId: "remote-1", presence }) as const;

// [case, planted state, effect, presence before, the move, the actor, presence after, targets_published_not_live after]
const MOVES: [string, string, string, string, string, string, string, number][] = [
  ["published", "dispatching", "possible", "removal_pending", "published", "W", "removed_at_provider", 1],
  ["failed with no effect", "dispatching", "possible", "removal_pending", "failed", "W", "present", 0],
  ["cancelled with no effect", "pending", "none", "removal_pending", "cancelled", "U", "present", 0],
  ["needs_human", "reconciling", "possible", "removal_pending", "needs_human", "R", "removal_unknown", 1],
  ["a person resends it", "needs_human", "none", "removal_unknown", "retry_wait", "U", "removal_pending", 1],
  [
    "published after the owner reported it",
    "dispatching",
    "possible",
    "removal_reported",
    "published",
    "W",
    "removal_reported",
    1,
  ],
];

describe("a delete operation's presence follows its state", () => {
  it("shows removal_pending once the delete is admitted", async () => {
    const e = await makeEnv();
    try {
      const id = await plant(e, { admitted: true, action: action("present") });
      expect(await shown(id)).toMatchObject({ presence: "removal_pending", k: 1 });
    } finally {
      await e.close();
    }
  });

  it.each(MOVES)("%s", async (_name, state, effect, before, to, actor, after, k) => {
    const e = await makeEnv();
    try {
      const id = await plant(e, { state, effect, action: action(before) });
      if (to === "failed") await noEffect(id);
      await move(id, to, actor);
      expect(await shown(id)).toMatchObject({ presence: after, k });
    } finally {
      await e.close();
    }
  });

  it.each(["edit", "delete"] as const)(
    "an edit changes no external_id, published_at, permalink, presence or post status (%s published)",
    async (kind) => {
      const e = await makeEnv();
      try {
        const id = await plant(e, {
          state: "dispatching",
          effect: "possible",
          action: { kind, externalId: "remote-1" },
        });
        const before = await shown(id);
        await move(id, "published", "W");
        const after = await shown(id);
        if (kind === "edit") expect(after).toEqual(before);
        else expect({ ...after, presence: "", k: 0 }).toEqual({ ...before, presence: "", k: 0 });
      } finally {
        await e.close();
      }
    },
  );
});
