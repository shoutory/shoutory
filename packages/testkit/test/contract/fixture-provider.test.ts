import {
  type FaultRow,
  faultMatrixRows,
  type MatrixHarness,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { manifestSchema } from "@shoutory/provider-sdk/manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureAdapter, type FixtureAdapterOptions } from "../../src/fixture-provider/adapter.js";
import { fixtureManifest } from "../../src/fixture-provider/manifest.js";
import { startFixtureSimulator } from "../../src/fixture-provider/simulator.js";

// The matrix takes the absent status and the revoked code from the manifest, so it plays what the provider declares.
const revoked = Object.entries(fixtureManifest.refreshErrorMap).find(([, kind]) => kind === "revoked");
if (!revoked) throw new Error("the fixture manifest declares no revoked refresh code");

const rows = faultMatrixRows({
  badRequestCodes: ["validation", "text_too_long"],
  capabilities: ["edit", "thread", "first_comment"],
  absentStatus: fixtureManifest.absentAnswers[0].status,
  revokedCode: revoked[0],
});

type Simulator = Awaited<ReturnType<typeof startFixtureSimulator>>;
let simulator: Simulator;

beforeEach(async () => {
  simulator = await startFixtureSimulator();
});

afterEach(async () => {
  const unused = simulator.pending();
  await simulator.close();
  expect(unused, "a fault was armed and no request used it").toBe(0);
});

function harness(options: Partial<FixtureAdapterOptions> = {}): MatrixHarness {
  return {
    adapter: createFixtureAdapter({ baseUrl: simulator.url, ...options }),
    context: { fetch, now: () => new Date("2026-11-21T00:00:00Z") },
    arm: simulator.arm,
    effects: simulator.effects,
    settle: simulator.settle,
    stored: simulator.stored,
    requestCount: simulator.requestCount,
  };
}

// A client that sends the request again when the answer is a 5xx.
function resending(): MatrixHarness {
  const base = harness();
  const resend = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const first = await base.context.fetch(input, init);
    return first.status >= 500 ? base.context.fetch(input, init) : first;
  };
  return { ...base, context: { ...base.context, fetch: resend as typeof fetch } };
}

const reportsNoEffectAfter5xx: FixtureAdapterOptions["mapFailure"] = ({ status }) => ({
  ok: false,
  effect: "none",
  errorClass: status >= 500 ? "retryable_before_send" : "permanent",
});
const readsTargetRefusalAsRevoked: FixtureAdapterOptions["mapFailure"] = ({ status }) => ({
  ok: false,
  effect: "none",
  errorClass: status === 403 ? "auth_revoked" : "permanent",
});

describe("the fixture provider passes the fault matrix", () => {
  it("declares a manifest the schema accepts", () => {
    expect(manifestSchema.safeParse(fixtureManifest).success).toBe(true);
  });

  it.each(rows.map((row): [string, FaultRow] => [row.id, row]))("row %s", async (_id, row) => {
    await row.run(harness());
  });
});

describe("the fixture adapter's errors and the matrix's refusals", () => {
  // What the adapter does with an error thrown by the client: only a network-coded failure is an outcome it may report.
  const socketClosed = Object.assign(new TypeError("terminated"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
  it.each([
    ["a closed socket is an unknown outcome", socketClosed, true],
    ["an error with no network code is a bug and is thrown", new TypeError("x is not a function"), false],
  ])("%s", async (_name, error, reported) => {
    const failing = harness();
    const context = { ...failing.context, fetch: (() => Promise.reject(error)) as typeof fetch };
    const answer = failing.adapter.commit(context, { idempotencyKey: "fixture-key-1", text: "text" });
    if (reported)
      await expect(answer).resolves.toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
    else await expect(answer).rejects.toBe(error);
  });
});

describe("the fault matrix refuses a wrong client", () => {
  // Adapters with the defects the matrix exists to catch, and the row that must refuse each.
  const WRONG: [string, () => MatrixHarness, string, RegExp][] = [
    [
      "reports no effect after a 5xx on a commit",
      () => harness({ mapFailure: reportsNoEffectAfter5xx }),
      "server-error-after-effect",
      /none with retryable_before_send is not allowed here/,
    ],
    [
      "reports no effect after a 5xx on a delete",
      () => harness({ mapFailure: reportsNoEffectAfter5xx }),
      "server-error-after-delete",
      /none with retryable_before_send is not allowed here/,
    ],
    [
      "reports no effect after a 5xx on an edit",
      () => harness({ mapFailure: reportsNoEffectAfter5xx }),
      "server-error-after-edit",
      /none with retryable_before_send is not allowed here/,
    ],
    [
      "reads a refusal of one target as a revoked grant",
      () => harness({ mapFailure: readsTargetRefusalAsRevoked }),
      "per-target-refusal",
      /auth_revoked is not allowed here/,
    ],
    [
      "sends the request again after a 5xx",
      resending,
      "server-error-after-effect",
      /one adapter call sent 2 requests/,
    ],
  ];

  it.each(WRONG)("refuses a client that %s", async (_name, build, rowId, message) => {
    const row = rows.find((candidate) => candidate.id === rowId);
    if (!row) throw new Error(`the matrix has no row ${rowId}`);
    await expect(row.run(build())).rejects.toThrow(message);
  });
});

describe("what the dispatch needs of the fixture provider", () => {
  it("a failed answer carries the http status of the provider, whatever the failure mapper says", async () => {
    // fails first because: the result drops the status, so core cannot compare it with the manifest's absentAnswers
    const context = { fetch, now: () => new Date("2026-11-21T00:00:00Z") };
    const result = await harness().adapter.readBack(context, { externalId: "no-such-post" });
    expect([result.ok, result.httpStatus]).toEqual([false, fixtureManifest.absentAnswers[0].status]);
    const wrong = await harness({ mapFailure: reportsNoEffectAfter5xx }).adapter.readBack(context, {
      externalId: "no-such-post",
    });
    expect(wrong.httpStatus).toBe(fixtureManifest.absentAnswers[0].status);
  });

  it("a request hook runs before the handler's effect, with the route it is for", async () => {
    // fails first because: the simulator has no hook, so a test cannot look at the ledger while the provider holds a call
    const seen: [string, number][] = [];
    const hooked = await startFixtureSimulator({
      before: (route) => {
        seen.push([route, hooked.effects()]);
      },
    });
    try {
      const context = { fetch, now: () => new Date("2026-11-21T00:00:00Z") };
      await createFixtureAdapter({ baseUrl: hooked.url }).commit(context, {
        idempotencyKey: "k",
        text: "hi",
      });
      expect(seen).toEqual([["POST /v1/posts", 0]]);
      expect(hooked.effects()).toBe(1);
    } finally {
      await hooked.close();
    }
  });
});
