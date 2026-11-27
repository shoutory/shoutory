import { createMastodonAdapter } from "@shoutory/provider-mastodon/adapter";
import { mastodonManifest } from "@shoutory/provider-mastodon/manifest";
import { startMastodonSimulator } from "@shoutory/provider-mastodon/simulator";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLedgerTick } from "../../src/jobs/ledger/tick.js";
import { runTurn } from "../../src/jobs/ledger/turn.js";
import { createLogger } from "../../src/logging/logger.js";
import { leaks } from "../support/canary.js";
import { ledgerCredentials } from "../support/ledger-credentials.js";
import {
  marked,
  opOf,
  plant,
  queueOf,
  rows,
  useDispatchEnv,
  workerPool,
} from "../support/ledger-dispatch-env.js";

useDispatchEnv();

const LEASE = 12;
const manifest = {
  ...mastodonManifest,
  leaseSeconds: { prepare: LEASE, commit: LEASE, readBack: LEASE, delete: LEASE },
  // A hung call ends at its own timeout, which a test keeps short.
  callTimeoutSeconds: 3,
};
const provider = {
  providerId: manifest.id,
  queueName: `publish.${manifest.id}`,
  reconcileQueue: `reconcile.${manifest.id}`,
  lease: LEASE,
};
const HOST_A = "one.example";
const HOST_B = "two.example";

type Seen = { host: string | undefined; authorization: string | null; method: string; path: string };
let sim: Awaited<ReturnType<typeof startMastodonSimulator>>;
const lines: string[] = [];
const hostsAsked: (string | undefined)[] = [];
const requests: Seen[] = [];
const logger = createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } });

// A channel with no stored host gets a fetch that refuses, as the production wiring does.
const fetchFor = (_given: unknown, host: string | undefined): typeof fetch => {
  hostsAsked.push(host);
  if (host === undefined) return () => Promise.reject(new TypeError("no egress is configured"));
  return (input, init) => {
    const url = new URL(String(input));
    requests.push({
      host: url.host,
      authorization: new Headers(init?.headers).get("authorization"),
      method: init?.method ?? "GET",
      path: url.pathname,
    });
    return fetch(new URL(`${url.pathname}${url.search}`, sim.url), init);
  };
};

const registry = createRegistry([manifest]);
const adapters = { [manifest.id]: createMastodonAdapter() };
const credentials = () => ledgerCredentials(workerPool(), { registry, adapters, fetchFor });
const turn = () =>
  runTurn({
    pool: workerPool(),
    logger,
    registry,
    adapters,
    fetchFor,
    credentials: credentials(),
    queue: provider.queueName,
    owner: "owner-instance",
    closing: new AbortController().signal,
  });
const tick = async () => {
  const loop = createLedgerTick({
    pool: workerPool(),
    boss: queueOf(),
    registry,
    adapters,
    fetchFor,
    credentials: credentials(),
    logger,
  });
  await loop.tick();
  await loop.reconcile();
};
const reset = () => {
  sim.reset();
  lines.length = 0;
  hostsAsked.length = 0;
  requests.length = 0;
};
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const posts = () => requests.filter((request) => request.method === "POST");

describe("an operation on an instance is sent with its channel's token and host (floor)", () => {
  it("each call carries its own channel's token and reaches only its own instance host", async () => {
    reset();
    const [tokenA, tokenB] = [sim.issueToken(), sim.issueToken()];
    await plant(provider, { host: HOST_A, token: tokenA });
    await plant(provider, { host: HOST_B, token: tokenB });
    await turn();
    await turn();
    const sent = posts().map(({ host, authorization }) => ({ host, authorization }));
    expect(sent.sort((a, b) => String(a.host).localeCompare(String(b.host)))).toEqual([
      { host: HOST_A, authorization: `Bearer ${tokenA}` },
      { host: HOST_B, authorization: `Bearer ${tokenB}` },
    ]);
    expect(new Set(hostsAsked)).toEqual(new Set([HOST_A, HOST_B]));
    expect(sim.stored()).toHaveLength(2);
  });

  it("a channel with no stored host sends nothing and its operation fails with no effect", async () => {
    reset();
    const id = await plant(provider, { token: sim.issueToken() });
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "failed", effect: "none" });
    expect(requests).toEqual([]);
    expect(sim.stored()).toEqual([]);
  });

  it("a channel with no stored credential waits with an operator alert before any call, never failed", async () => {
    reset();
    const id = await plant(provider, { host: HOST_A, noCredential: true });
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "retry_wait", effect: "none" });
    expect(lines.some((line) => line.includes("credential_unusable") && line.includes(id))).toBe(true);
    expect(hostsAsked).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe("an answer the adapter cannot read is an unknown outcome and is never sent again (floor)", () => {
  const FAULTS = [
    ["a 5xx after the status was created", { kind: "respond", status: 503, afterEffect: true }],
    ["an answer cut off after the status was created", { kind: "truncate" }],
    ["a read timeout after the body was sent", { kind: "hang", effectDelayMs: 100 }],
  ] as const;
  it.each(FAULTS)(
    "%s on commit ends in unknown_external_state, never retry_wait",
    async (_name, fault) => {
      reset();
      const id = await plant(provider, { host: HOST_A, token: sim.issueToken() });
      sim.arm("commit", fault);
      await turn();
      expect(await opOf(id)).toMatchObject({ state: "unknown_external_state", effect: "possible" });
    },
    30_000,
  );

  it("the key is the operation marker; with no id to read back the unknown outcome goes to a person and nothing is sent again", async () => {
    reset();
    const id = await plant(provider, { host: HOST_A, token: sim.issueToken() });
    sim.arm("commit", { kind: "respond", status: 503, afterEffect: true });
    await turn();
    const [operation] = await rows("SELECT idempotency_marker AS marker FROM app.operations WHERE id = $1", [
      id,
    ]);
    const keys = sim.requests
      .filter((request) => request.method === "POST")
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toEqual([operation?.marker]);
    await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
    await tick();
    expect(posts()).toHaveLength(1);
    expect(sim.stored()).toHaveLength(1);
    expect(await opOf(id)).toMatchObject({ state: "needs_human", reason_code: "no_remote_id" });
  });
});

const unknownWith = async (planted: Parameters<typeof plant>[1], externalId: string) => {
  const id = await plant(provider, {
    state: "unknown_external_state",
    effect: "possible",
    reconcile: true,
    ...planted,
  });
  await marked(id, externalId, 120);
  await rows("UPDATE app.operations SET next_check_at = now() WHERE id = $1", [id]);
  return id;
};
const seededStatus = async (token: string): Promise<string> => {
  const made = await fetch(`${sim.url}/api/v1/statuses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "seeded" }),
  });
  return String(((await made.json()) as { id: string }).id);
};

describe("the read-back of an unknown outcome is made as its own channel (floor)", () => {
  it("reads each id with its own channel's token on its own host: a 200 confirms the post, a 404 is an absent answer", async () => {
    reset();
    const [tokenA, tokenB] = [sim.issueToken(), sim.issueToken()];
    const idA = await seededStatus(tokenA);
    const found = await unknownWith({ host: HOST_A, token: tokenA }, idA);
    const gone = await unknownWith({ host: HOST_B, token: tokenB }, "109000000000099999");
    await tick();
    const reads = requests.filter((request) => request.method === "GET");
    expect(reads.map(({ host, authorization, path }) => ({ host, authorization, path }))).toEqual(
      expect.arrayContaining([
        { host: HOST_A, authorization: `Bearer ${tokenA}`, path: `/api/v1/statuses/${idA}` },
        { host: HOST_B, authorization: `Bearer ${tokenB}`, path: "/api/v1/statuses/109000000000099999" },
      ]),
    );
    expect(reads).toHaveLength(2);
    expect(await opOf(found)).toMatchObject({ state: "published" });
    const [absent] = await rows(
      "SELECT error_class FROM app.operation_attempts WHERE operation_id = $1 AND step = 'read_back'",
      [gone],
    );
    expect(absent?.error_class).toBe("absent");
  });

  it("a channel with no usable credential goes to a person with its reason and no request is made", async () => {
    reset();
    const id = await unknownWith({ host: HOST_A, noCredential: true }, "109000000000012345");
    await tick();
    expect(await opOf(id)).toMatchObject({ state: "needs_human", reason_code: "credential_unavailable" });
    expect(requests).toEqual([]);
  });
});

describe("a refused send waits and is sent again with the same key", () => {
  it("a 429 on commit leaves the operation waiting, and its next turn sends the same Idempotency-Key once more", async () => {
    reset();
    const id = await plant(provider, { host: HOST_A, token: sim.issueToken() });
    sim.arm("commit", { kind: "respond", status: 429 });
    await turn();
    expect(await opOf(id)).toMatchObject({ state: "retry_wait", effect: "none" });
    await rows("UPDATE app.operations SET next_attempt_at = now() WHERE id = $1", [id]);
    // The 429 also paused the account's bucket; its cooldown is over. The tick's sweep puts the waiting row back on the
    // queue and the next turn claims and sends it.
    await rows("UPDATE app.rate_buckets SET paused_until = now() WHERE scope = 'account'");
    await tick();
    expect(await turn()).toMatchObject({ kind: "dispatched" });
    const [operation] = await rows("SELECT idempotency_marker AS marker FROM app.operations WHERE id = $1", [
      id,
    ]);
    const keys = sim.requests
      .filter((request) => request.method === "POST")
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toEqual([operation?.marker, operation?.marker]);
    expect(sim.stored()).toHaveLength(1);
  });
});

describe("the token is in no log, attempt or operation row (floor)", () => {
  it("a send that fails and one that succeeds leave the token in no log line, attempt, operation or event", async () => {
    reset();
    const token = sim.issueToken();
    expect(token.length).toBeGreaterThanOrEqual(16);
    await plant(provider, { host: HOST_A, token });
    await plant(provider, { host: HOST_A, token });
    // The refusal echoes the token in its body, as a careless instance might; the adapter must not carry the body on.
    sim.arm("commit", { kind: "respond", status: 401, echoId: token });
    await turn();
    await turn();
    const tables = await Promise.all(
      ["operation_attempts", "operations", "operation_evidence", "outbox", "audit_logs"].map((table) =>
        rows(`SELECT row_to_json(t)::text AS t FROM app.${table} t`),
      ),
    );
    expect(leaks([...lines, JSON.stringify(tables)].join("\n"), [token])).toEqual([]);
  });
});
