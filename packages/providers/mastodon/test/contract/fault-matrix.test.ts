import {
  type FaultRow,
  faultMatrixRows,
  type MatrixHarness,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { mastodonManifest } from "../../src/manifest.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/instance.js";

// The matrix knows nothing of an account, so the harness hands the adapter the channel's token and host the way the
// worker does. The page documents no machine code for a 422 (`{"error":"Validation failed: ..."}`), so no bad-request
// code is played and a 422 is classed by its status; the text a 401 carries is the documented one
// (docs.joinmastodon.org/methods/statuses, accessed 2026-11-24).
const rows = faultMatrixRows({
  manifest: mastodonManifest,
  badRequestCodes: [],
  revokedCode: "The access token is invalid",
});

let sim: MastodonSimulator;
beforeEach(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterEach(async () => {
  const unused = sim.faults.pending();
  await sim.close();
  expect(unused, "a fault was armed and no request used it").toBe(0);
});

function harness(): MatrixHarness {
  const adapter = createMastodonAdapter();
  const account = accountOf(sim.issueToken());
  const { context } = recorder(sim);
  return {
    adapter: {
      ...adapter,
      commit: (given, input) => adapter.commit(given, { ...input, account }),
      readBack: (given, post) => adapter.readBack(given, { ...post, account }),
      delete: (given, post) => adapter.delete(given, { ...post, account }),
    },
    context,
    arm: sim.arm,
    effects: () => sim.effects(),
    settle: () => sim.settle(),
    stored: sim.stored,
    // A read that confirms a 404 on a delete is no resend, so only requests that can change something are counted.
    requestCount: () => sim.requests.filter((request) => request.method !== "GET").length,
  };
}

describe("the Mastodon provider passes the fault matrix", () => {
  it("declares a manifest the schema accepts, with text and delete", () => {
    expect(manifestSchema.parse(mastodonManifest).capabilities).toEqual(["text", "delete"]);
  });

  it.each(rows.map((row): [string, FaultRow] => [row.id, row]))("row %s", async (_id, row) => {
    await row.run(harness());
  });
});
