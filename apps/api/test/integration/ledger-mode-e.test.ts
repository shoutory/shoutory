import { builtInManifests } from "@shoutory/provider-registry";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { describe, expect, it } from "vitest";
import { makeEnv, opOf, plant, rows, typesOf, useDispatchEnv } from "../support/ledger-dispatch-env.js";

useDispatchEnv();

// A provider that cannot read a post back has no id to look for after a lost answer, so what its manifest declares must
// never let the ledger send a second time. Each registered provider of that class runs the fixture's lost-answer case
// under its own declared policy.
const modeE = builtInManifests
  .map((manifest) => manifestSchema.parse(manifest))
  .filter((manifest) => manifest.readBackMode === "E");

describe("an unknown commit of every provider that cannot read back (floor)", () => {
  it("the registry holds more than one of them, so the rows below are not empty", () => {
    expect(modeE.length).toBeGreaterThan(1);
  });

  it.each(modeE.map((manifest) => [manifest.id, manifest] as const))(
    "%s: a lost commit ends needs_human and the provider is called once",
    async (_id, manifest) => {
      const { readBackMode, idempotency, retrySafety } = manifest;
      const e = await makeEnv({ manifest: { readBackMode, idempotency, retrySafety } });
      try {
        e.sim.arm("commit", { kind: "hang" });
        const id = await plant(e);
        await e.turn();
        expect(await opOf(id)).toMatchObject({ state: "unknown_external_state", effect: "possible" });
        await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
        await e.tick();
        await e.tick();
        expect(e.commits.count).toBe(1);
        expect(await opOf(id)).toMatchObject({ state: "needs_human" });
        expect(await typesOf(id)).not.toContain("operation.retry_wait");
      } finally {
        await e.close();
      }
    },
    60_000,
  );
});
