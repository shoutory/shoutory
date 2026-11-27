import { createHash } from "node:crypto";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { describe, expect, it } from "vitest";
import {
  type Env,
  ledger,
  makeEnv,
  opOf,
  plant,
  rows,
  useDispatchEnv,
} from "../support/ledger-dispatch-env.js";

useDispatchEnv();

type Kind = "edit" | "delete";
const ROUTE = { edit: "PATCH /v1/posts/:id", delete: "DELETE /v1/posts/:id" } as const;

function counter() {
  const seen: Record<string, number> = {};
  return {
    seen,
    before: (route: string) => {
      seen[route] = (seen[route] ?? 0) + 1;
    },
  };
}

async function remote(e: Env): Promise<string> {
  const made = await fetch(`${e.sim.url}/v1/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "original text" }),
  });
  return ((await made.json()) as { id: string }).id;
}

describe("a delete the provider says is already gone", () => {
  it("is removed on the adapter's confirmed 404, with the held id as evidence and the presence moved", async () => {
    const calls = counter();
    const e = await makeEnv({ before: calls.before });
    try {
      const id = await plant(e, { action: { kind: "delete", externalId: "gone-1" } });
      await e.turn();
      expect(await opOf(id)).toMatchObject({ state: "published" });
      expect(calls.seen[ROUTE.delete]).toBe(1);
      const [evidence] = await rows(
        "SELECT kind, level, external_id FROM app.operation_evidence WHERE operation_id = $1",
        [id],
      );
      expect(evidence).toEqual({ kind: "removed", level: "receipt", external_id: "gone-1" });
      const [target] = await rows(
        "SELECT v.presence FROM app.operations o JOIN app.post_variants v ON v.id = o.variant_id WHERE o.id = $1",
        [id],
      );
      expect(target?.presence).toBe("removed_at_provider");
    } finally {
      await e.close();
    }
  }, 30_000);
});

const LIMITS = [
  { name: "api", scope: "account", key: "account", max: 1000, windowSeconds: 300 },
  { name: "delete", scope: "account", key: "account", max: 1000, windowSeconds: 1800, spentBy: "delete" },
];
const bucketOf = async (id: string, providerId: string, limit: string) => {
  const [row] = await rows(
    `SELECT c.provider_account_id AS account FROM app.channels c JOIN app.operations o ON o.channel_id = c.id
      WHERE o.id = $1`,
    [id],
  );
  return createHash("sha256")
    .update([providerId, limit, "account", String(row?.account)].join("\0"))
    .digest("hex");
};

// [kind, the bucket the provider has paused, the state the turn ends in, calls of the action route]
const PAUSED: [Kind, string, string, number][] = [
  ["delete", "delete", "retry_wait", 0],
  ["delete", "api", "retry_wait", 0],
  ["edit", "api", "retry_wait", 0],
  ["edit", "delete", "published", 1],
];
describe("the buckets an edit and a delete spend", () => {
  it.each(PAUSED)(
    "%s with the %s bucket paused ends %s",
    async (kind, paused, ends, sent) => {
      const calls = counter();
      const e = await makeEnv({ before: calls.before, manifest: { rateLimits: LIMITS } });
      try {
        const externalId = await remote(e);
        const id = await plant(e, { action: { kind, externalId } });
        await ledger(
          "SELECT app.bucket_pause($1, 'account', now() + interval '10 minutes', 'rate_limited')",
          [await bucketOf(id, e.providerId, paused)],
        );
        await e.turn();
        expect(await opOf(id)).toMatchObject({ state: ends });
        expect(calls.seen[ROUTE[kind]] ?? 0).toBe(sent);
      } finally {
        await e.close();
      }
    },
    30_000,
  );
});

const PERSON = {
  readBackMode: "E",
  idempotency: { ...fixtureManifest.idempotency, resendAfterUnknown: "read_back_only" },
  retrySafety: { prepare: "safe", commit: "never", readBack: "safe", edit: "never", delete: "safe" },
};
describe("the read-back pass", () => {
  it("goes on to the next due row after one is handed to a person (a row another worker holds still ends the pass)", async () => {
    const e = await makeEnv({ manifest: PERSON });
    try {
      const unknown = { state: "unknown_external_state", effect: "possible", reconcile: true } as const;
      const edit = await plant(e, { ...unknown, action: { kind: "edit", externalId: "p-1" } });
      const del = await plant(e, { ...unknown, action: { kind: "delete", externalId: "p-2" } });
      await rows("UPDATE app.operations SET next_check_at = now() - interval '1 hour' WHERE id = $1", [edit]);
      await e.tick();
      expect(await opOf(edit)).toMatchObject({ state: "needs_human" });
      expect(await opOf(del)).toMatchObject({ state: "retry_wait" });
    } finally {
      await e.close();
    }
  }, 30_000);
});
