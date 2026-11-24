import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/instance.js";

// What the fault matrix does not prove about publishing, read-back and delete (the matrix plays every status and fault
// class against the adapter, so none of that is repeated here). The Idempotency-Key is the one the caller gave and is the
// same on every send of it; a call that is not given its channel's token and host is refused before anything is sent; a
// read-back and a delete name only the id they were asked about; and the token is in no answer the adapter gives. The
// simulator is built from docs.joinmastodon.org/methods/statuses (read 2026-11-24).
let sim: MastodonSimulator;
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const adapter = createMastodonAdapter();
const publish = (text: string, key: string, token: string) => {
  const { context, seen } = recorder(sim);
  return {
    seen,
    sent: adapter.commit(context, { idempotencyKey: key, text, account: accountOf(token) }),
    context,
  };
};

describe("the Idempotency-Key of a commit (floor)", () => {
  it("is the key the caller gave on every send, and the simulator, which assumes a repeated key answers the same status (VERIFY, V-58), keeps one status", async () => {
    sim.reset();
    const token = sim.issueToken();
    const [first, second] = [publish("hello", "admit-key-1", token), publish("hello", "admit-key-1", token)];
    const [one, two] = [await first.sent, await second.sent];
    expect([one.ok, two.ok]).toEqual([true, true]);
    // One call sends one request: a resend after an unknown outcome is the ledger's decision, never the adapter's.
    expect([first.seen.length, second.seen.length]).toEqual([1, 1]);
    expect(two.externalId).toBe(one.externalId);
    expect(sim.stored()).toHaveLength(1);
    expect(sim.effects()).toBe(1);
    const posts = sim.requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.headers["idempotency-key"])).toEqual([
      "admit-key-1",
      "admit-key-1",
    ]);
  });
});

// The rate-limits page documents X-RateLimit-Limit, -Remaining and -Reset (an ISO time) and no Retry-After
// (docs.joinmastodon.org/api/rate-limits, accessed 2026-11-24), so a 429 that names no Retry-After is read from the reset.
describe("the delay of a 429 (rate limits)", () => {
  it("is the time left until X-RateLimit-Reset when no Retry-After is sent", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const reset = new Date(context.now().getTime() + 30_000).toISOString();
    sim.faults.failNext("POST /api/v1/statuses", {
      kind: "respond",
      status: 429,
      body: { error: "Too many requests" },
      headers: { "x-ratelimit-reset": reset },
    });
    const answer = await adapter.commit(context, {
      idempotencyKey: "limited-1",
      text: "t",
      account: accountOf(sim.issueToken()),
    });
    expect(answer).toMatchObject({
      ok: false,
      effect: "none",
      errorClass: "rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("on a delete is rate_limited with no effect", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const account = accountOf(sim.issueToken());
    const made = await adapter.commit(context, { idempotencyKey: "limited-2", text: "t", account });
    sim.arm("delete", { kind: "respond", status: 429 });
    const answer = await adapter.delete(context, { externalId: String(made.externalId), account });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "rate_limited" });
  });
});

describe("a validation answer is classed by its status", () => {
  it("a 422 on create, with the documented text and no machine code, is a permanent failure with no effect", async () => {
    sim.reset();
    const { context } = recorder(sim);
    sim.arm("commit", { kind: "respond", status: 422 });
    const answer = await adapter.commit(context, {
      idempotencyKey: "invalid-1",
      text: "",
      account: accountOf(sim.issueToken()),
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "permanent", httpStatus: 422 });
    expect(sim.stored()).toEqual([]);
  });
});

describe("a call with no channel token or host is refused before anything is sent (floor)", () => {
  const account = accountOf("token-for-refusal");
  const NO_HOST = { accessToken: account.accessToken };
  const CALLS: [string, (context: ReturnType<typeof recorder>["context"]) => Promise<unknown>][] = [
    ["a commit with no account", (c) => adapter.commit(c, { idempotencyKey: "k-1", text: "t" })],
    [
      "a commit with an account that has no host",
      (c) => adapter.commit(c, { idempotencyKey: "k-2", text: "t", account: NO_HOST }),
    ],
    [
      "a commit with an empty idempotency key",
      (c) => adapter.commit(c, { idempotencyKey: "", text: "t", account }),
    ],
    ["a read-back with no account", (c) => adapter.readBack(c, { externalId: "1" })],
    [
      "a read-back with an account that has no host",
      (c) => adapter.readBack(c, { externalId: "1", account: NO_HOST }),
    ],
    ["a delete with no account", (c) => adapter.delete(c, { externalId: "1" })],
    [
      "a delete with an account that has no host",
      (c) => adapter.delete(c, { externalId: "1", account: NO_HOST }),
    ],
  ];
  it.each(CALLS)("%s is a permanent invalid_input with no effect and no request", async (_name, call) => {
    sim.reset();
    const { context, seen } = recorder(sim);
    expect(await call(context)).toMatchObject({
      ok: false,
      effect: "none",
      errorClass: "permanent",
      providerCode: "invalid_input",
    });
    expect(seen).toEqual([]);
  });
});

describe("a read-back that fails is never an absent answer, and an answer that is not the status asked confirms nothing", () => {
  const READ = "GET /api/v1/statuses/:id";
  const FAULTS: [string, object, boolean][] = [
    ["a 503", { kind: "respond", status: 503, body: { error: "unavailable" } }, false],
    ["a 401", { kind: "respond", status: 401, body: { error: "The access token is invalid" } }, false],
    ["a 429", { kind: "respond", status: 429, body: { error: "Too many requests" } }, false],
    ["a read timeout", { kind: "hang" }, false],
    ["a 200 whose body is not JSON", { kind: "respond", status: 200, body: "<html>stub</html>" }, true],
    [
      "a 200 whose id is another status'",
      { kind: "respond", status: 200, body: { id: "109000000000000999" } },
      true,
    ],
  ];
  it.each(FAULTS)("%s is not absent and does not confirm", async (_name, fault, answered) => {
    sim.reset();
    const { context } = recorder(sim);
    const timed = {
      ...context,
      fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        context.fetch(input, { ...init, signal: AbortSignal.timeout(150) })) as typeof fetch,
    };
    const account = accountOf(sim.issueToken());
    const made = await adapter.commit(context, { idempotencyKey: "read-1", text: "t", account });
    sim.faults.failNext(READ, fault as Parameters<typeof sim.faults.failNext>[1]);
    const answer = await adapter.readBack(timed, { externalId: String(made.externalId), account });
    expect(answer.ok).toBe(false);
    expect(answer.absent).not.toBe(true);
    expect(answer.httpStatus).not.toBe(404);
    expect(answer.effect).toBe("none");
    // The ones the instance did answer with a 200 are unusable, not a refusal of the call.
    if (answered) expect(answer).toMatchObject({ errorClass: "unknown" });
  });
});

// A 404 on a delete is taken as "gone" only when one read of the same id agrees (a stale or proxied 404 on the delete
// alone proves nothing); a post that is still there, or a read that cannot say, is an unknown outcome for a person.
describe("a delete answered 404 is confirmed by one read of the id", () => {
  const FOLLOWING_READ: [string, object | undefined, object][] = [
    ["404", undefined, { ok: true, effect: "none" }],
    [
      "200 with the same id (the post is still live)",
      undefined,
      { ok: false, effect: "possible", errorClass: "unknown", providerCode: "still_present" },
    ],
    [
      "a 503",
      { kind: "respond", status: 503, body: { error: "unavailable" } },
      { ok: false, errorClass: "unknown" },
    ],
  ];
  it.each(FOLLOWING_READ)("with a read that answers %s", async (name, fault, expected) => {
    sim.reset();
    const { context } = recorder(sim);
    const account = accountOf(sim.issueToken());
    const made = await adapter.commit(context, { idempotencyKey: "gone-1", text: "t", account });
    const id = name.startsWith("404") ? "999" : String(made.externalId);
    sim.faults.failNext("DELETE /api/v1/statuses/:id", {
      kind: "respond",
      status: 404,
      body: { error: "Record not found" },
    });
    if (fault)
      sim.faults.failNext("GET /api/v1/statuses/:id", fault as Parameters<typeof sim.faults.failNext>[1]);
    const answer = await adapter.delete(context, { externalId: id, account });
    expect(answer).toMatchObject(expected);
    const after = sim.requests.filter((request) => request.path.endsWith(`/${id}`));
    expect(after.map((request) => request.method)).toEqual(["DELETE", "GET"]);
    expect(sim.stored()).toHaveLength(1);
  });
});

// A status answer is read up to 512 KB; a longer one is no answer, so it confirms nothing (the page of the statuses
// methods documents no size, so the bound is ours).
describe("an oversized answer is no answer", () => {
  const PAD = "x".repeat(600_000);
  it("a create answered 200 with an oversized body is an unknown outcome, never a success", async () => {
    sim.reset();
    const { context } = recorder(sim);
    sim.faults.failNext("POST /api/v1/statuses", {
      kind: "respond",
      status: 200,
      body: { id: "109000000000000001", pad: PAD },
    });
    const answer = await adapter.commit(context, {
      idempotencyKey: "big-1",
      text: "t",
      account: accountOf(sim.issueToken()),
    });
    expect(answer).toMatchObject({ ok: false, effect: "possible", errorClass: "unknown" });
  });

  it("a read-back answered 200 with the right id and an oversized body does not confirm and is not absent", async () => {
    sim.reset();
    const { context } = recorder(sim);
    const account = accountOf(sim.issueToken());
    const made = await adapter.commit(context, { idempotencyKey: "big-2", text: "t", account });
    sim.faults.failNext("GET /api/v1/statuses/:id", {
      kind: "respond",
      status: 200,
      body: { id: String(made.externalId), pad: PAD },
    });
    const answer = await adapter.readBack(context, { externalId: String(made.externalId), account });
    expect(answer).toMatchObject({ ok: false, effect: "none", errorClass: "unknown" });
    expect(answer.absent).not.toBe(true);
  });
});

describe("an id that came from an instance is checked before it is put in a path", () => {
  it.each(["12/34", "../1", "1?x=1", "a b", ""])(
    "the id %j is refused as invalid_input with no request, for a read-back and a delete",
    async (externalId) => {
      sim.reset();
      const { context, seen } = recorder(sim);
      const account = accountOf(sim.issueToken());
      for (const answer of [
        await adapter.readBack(context, { externalId, account }),
        await adapter.delete(context, { externalId, account }),
      ]) {
        expect(answer).toMatchObject({
          ok: false,
          effect: "none",
          errorClass: "permanent",
          providerCode: "invalid_input",
        });
      }
      expect(seen).toEqual([]);
    },
  );
});

describe("a read-back and a delete name only the id asked (BG-16)", () => {
  // The documented 404 body, `{"error":"Record not found"}` (docs.joinmastodon.org/methods/statuses, accessed 2026-11-24),
  // is played by the matrix. This body is test input only, not a Mastodon fact: it proves the status alone decides absence.
  it("a 404 whose body is some other text is reported with its status, for the id asked and no other", async () => {
    const body = { error: "a body the documentation does not name" };
    sim.reset();
    const token = sim.issueToken();
    const { context, seen } = recorder(sim);
    const kept = await adapter.commit(context, {
      idempotencyKey: "keep-1",
      text: "kept",
      account: accountOf(token),
    });
    sim.faults.failNext("GET /api/v1/statuses/:id", { kind: "respond", status: 404, body });
    const asked = await adapter.readBack(context, { externalId: "999", account: accountOf(token) });
    expect(asked).toMatchObject({ ok: false, effect: "none", errorClass: "permanent", httpStatus: 404 });
    expect(asked.externalId).toBeUndefined();
    const found = await adapter.readBack(context, {
      externalId: String(kept.externalId),
      account: accountOf(token),
    });
    expect(found).toMatchObject({ ok: true, externalId: kept.externalId });
    expect(seen.filter((call) => call.method === "GET").map((call) => call.path)).toEqual([
      "/api/v1/statuses/999",
      `/api/v1/statuses/${kept.externalId}`,
    ]);
  });

  it("a delete removes the one status it names and sends nothing else, so another status stays", async () => {
    sim.reset();
    const token = sim.issueToken();
    const { context, seen } = recorder(sim);
    const [a, b] = [
      await adapter.commit(context, { idempotencyKey: "del-a", text: "a", account: accountOf(token) }),
      await adapter.commit(context, { idempotencyKey: "del-b", text: "b", account: accountOf(token) }),
    ];
    const before = seen.length;
    const gone = await adapter.delete(context, {
      externalId: String(a.externalId),
      account: accountOf(token),
    });
    expect(gone).toMatchObject({ ok: true, effect: "confirmed" });
    // A 200 is the whole answer: no read follows it.
    expect(seen.length - before).toBe(1);
    expect(sim.stored().map((post) => post.externalId)).toEqual([b.externalId]);
    const deletes = sim.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => `${request.path}?${request.query}`)).toEqual([
      `/api/v1/statuses/${a.externalId}?`,
    ]);
    expect(seen.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });
});

describe("the token is in no answer of the adapter (floor)", () => {
  // The raw token, then the spellings it can take in a log line, a body or a dump (AGENTS 4.2).
  const FORMS = (secret: string) => [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("hex"),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    JSON.stringify(secret).slice(1, -1),
  ];

  it("a result, whether it succeeded or failed, shows the token in no string form", async () => {
    sim.reset();
    const token = sim.issueToken();
    expect(token.length).toBeGreaterThanOrEqual(16);
    const { context } = recorder(sim);
    const account = accountOf(token);
    const made = await adapter.commit(context, { idempotencyKey: "canary-1", text: "x", account });
    sim.faults.failNext("POST /api/v1/statuses", { kind: "respond", status: 401, body: { error: token } });
    sim.faults.failNext("GET /api/v1/statuses/:id", { kind: "respond", status: 500, body: { error: token } });
    // The OAuth-style fields an instance may echo a secret in: neither text is ever carried into a result.
    sim.faults.failNext("POST /api/v1/statuses", {
      kind: "respond",
      status: 403,
      body: { error: "invalid_scope", error_description: token },
    });
    const results = [
      await adapter.commit(context, { idempotencyKey: "canary-3", text: "x", account }),
      made,
      await adapter.commit(context, { idempotencyKey: "canary-2", text: "x", account }),
      await adapter.readBack(context, { externalId: String(made.externalId), account }),
      await adapter.delete(context, { externalId: String(made.externalId), account }),
    ];
    const shown = results
      .flatMap((result) => [inspect(result, { depth: 6 }), JSON.stringify(result)])
      .join("\n");
    expect(FORMS(token).filter((form) => shown.includes(form))).toEqual([]);
  });
});
