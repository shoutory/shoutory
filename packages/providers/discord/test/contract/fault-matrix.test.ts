import {
  type FaultRow,
  faultMatrixRows,
  type MatrixHarness,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiscordAdapter } from "../../src/adapter.js";
import { discordManifest } from "../../src/manifest.js";
import { type DiscordSimulator, startDiscordSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/webhook.js";

// The two codes the docs give for a 400 on an execute: an empty message and an invalid form body
// (docs.discord.com/developers/topics/opcodes-and-status-codes, accessed 2026-11-27). A webhook has no read-back, so the
// matrix plays no read-back row and fails any row that reaches for one.
const rows = faultMatrixRows({
  manifest: discordManifest,
  badRequestCodes: ["50006", "50035"],
  revokedCode: "50027",
});

let sim: DiscordSimulator;
beforeEach(async () => {
  sim = await startDiscordSimulator();
});
afterEach(async () => {
  const unused = sim.faults.pending();
  await sim.close();
  expect(unused, "a fault was armed and no request used it").toBe(0);
});

function harness(): MatrixHarness {
  const adapter = createDiscordAdapter();
  const account = accountOf(sim.urlFor());
  const { context } = recorder(sim);
  return {
    adapter: {
      ...adapter,
      commit: (given, input) => adapter.commit(given, { ...input, account }),
      readBack: (given, post) => adapter.readBack(given, { ...post, account }),
      delete: (given, post) => adapter.delete(given, { ...post, account }),
      edit: (given, post, input) => {
        if (!adapter.edit) throw new Error("the adapter has no edit");
        return adapter.edit(given, { ...post, account }, input);
      },
    },
    context,
    arm: sim.arm,
    effects: () => sim.effects(),
    settle: () => sim.settle(),
    stored: sim.stored,
    requestCount: () => sim.requests.length,
  };
}

describe("the Discord provider passes the fault matrix", () => {
  it.each(rows.map((row): [string, FaultRow] => [row.id, row]))("row %s", async (_id, row) => {
    await row.run(harness());
  });
});
