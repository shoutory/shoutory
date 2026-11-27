import { faultMatrixRows, type MatrixHarness } from "@shoutory/provider-sdk/conformance/fault-matrix";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { afterEach, describe, expect, it } from "vitest";
import { createBlueskyAdapter } from "../../src/adapter.js";
import { blueskyManifest } from "../../src/manifest.js";
import type { BlueskySimulator } from "../../src/simulator.js";
import { accountOf, makeKeys, network } from "../support/network.js";

// The harness hands the adapter the account the way the worker does. The PDS answers a bad request with `InvalidRequest`
// and a token it no longer takes with `ExpiredToken` (the lexicon error names of com.atproto.repo.createRecord, read
// 2026-11-27); DPoP nonces are played in the unit rows, so the simulator takes proofs without one here.
const rows = faultMatrixRows({
  manifest: blueskyManifest,
  badRequestCodes: ["InvalidRequest"],
  revokedCode: "ExpiredToken",
  uploads: true,
});

const SMALL = { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };

let sim: BlueskySimulator | undefined;
afterEach(() => {
  expect(sim?.faults.pending() ?? 0, "a fault was armed and no request used it").toBe(0);
});

async function harness(): Promise<MatrixHarness> {
  const net = await network({ nonces: false });
  sim = net.sim;
  const adapter = createBlueskyAdapter();
  const account = accountOf(makeKeys());
  return {
    adapter: {
      ...adapter,
      commit: (given, input) => adapter.commit(given, { ...input, account }),
      readBack: (given, post) => adapter.readBack(given, { ...post, account }),
      delete: (given, post) => adapter.delete(given, { ...post, account }),
    },
    context: net.context,
    upload: (_kind, given) => {
      const media = {
        items: [{ mime: SMALL.mime, size: SMALL.bytes.length, altText: "matrix alt" }],
        read: async () => ({ bytes: SMALL.bytes, altText: "matrix alt" }),
      };
      return adapter.prepare(
        { ...given, media },
        { idempotencyKey: "matrix-upload", text: "t", account, mediaIds: [] },
      );
    },
    arm: net.sim.arm,
    effects: () => net.sim.effects(),
    settle: () => net.sim.settle(),
    stored: net.sim.stored,
    requestCount: () => net.sim.requests.filter((request) => request.method !== "GET").length,
  };
}

describe("the Bluesky provider passes the fault matrix", () => {
  it("declares a manifest the schema accepts, with text, image, thread, first comment, delete and refresh", () => {
    expect(manifestSchema.parse(blueskyManifest)).toMatchObject({
      capabilities: ["text", "image", "thread", "first_comment", "delete", "refresh"],
      followUpRoles: ["thread_reply", "first_comment"],
    });
  });

  it.each(rows.map((row) => [row.id, row] as const))("%s", async (_id, row) => {
    await row.run(await harness());
  });
});
