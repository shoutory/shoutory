import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMastodonAdapter } from "../../src/adapter.js";
import { type MastodonSimulator, startMastodonSimulator } from "../../src/simulator.js";
import { accountOf, recorder } from "../support/instance.js";

let sim: MastodonSimulator;
beforeAll(async () => {
  sim = await startMastodonSimulator({ now: () => new Date() });
});
afterAll(() => sim.close());

const adapter = createMastodonAdapter();
const EDIT = "PUT /api/v1/statuses/:id";

async function seeded(key: string) {
  sim.reset();
  const { context } = recorder(sim);
  const account = accountOf(sim.issueToken());
  const made = await adapter.commit(context, { idempotencyKey: key, text: "first", account });
  return { context, account, id: String(made.externalId) };
}

function edit(
  { context, account, id }: Awaited<ReturnType<typeof seeded>>,
  input: Parameters<NonNullable<typeof adapter.edit>>[2] = { text: "second" },
) {
  if (!adapter.edit) throw new Error("the adapter has no edit");
  return adapter.edit(context, { externalId: id, account }, input);
}

describe("an edit of a published status (floor: unknown external state)", () => {
  const FAULTS: [string, object, object][] = [
    [
      "a 200 that names another status",
      { kind: "respond", status: 200, body: { id: "109000000000000999" } },
      { ok: false, effect: "possible", errorClass: "unknown" },
    ],
    [
      "a 404 (missing, private or not the account's)",
      { kind: "respond", status: 404, body: { error: "Record not found" } },
      { ok: false, effect: "none", errorClass: "permanent", httpStatus: 404 },
    ],
    [
      "a 503 after the request was sent",
      { kind: "respond", status: 503, body: { error: "unavailable" } },
      { ok: false, effect: "possible", errorClass: "unknown" },
    ],
    [
      "a 401",
      { kind: "respond", status: 401, body: { error: "The access token is invalid" } },
      { ok: false, effect: "none", errorClass: "auth_revoked" },
    ],
  ];
  it.each(FAULTS)("%s is never reported as done", async (_name, fault, expected) => {
    const post = await seeded("edit-fault-1");
    sim.faults.failNext(EDIT, fault as Parameters<typeof sim.faults.failNext>[1]);
    expect(await edit(post)).toMatchObject(expected);
  });

  it("is refused before any request when the id is not an id", async () => {
    const post = await seeded("edit-fault-2");
    const { context, seen } = recorder(sim);
    const answer = await edit({ ...post, context, id: "../accounts/1" });
    expect(answer).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
    expect(seen).toEqual([]);
  });
});

describe("a reply names only an id the instance could have made (floor)", () => {
  it.each([["../accounts/1"], ["1?visibility=direct"], ["a b"], [""], ["9".repeat(65)]])(
    "%j is refused before any request",
    async (id) => {
      sim.reset();
      const { context, seen } = recorder(sim);
      const answer = await adapter.commit(context, {
        idempotencyKey: "reply-id-1",
        text: "reply",
        replyToExternalId: id,
        account: accountOf(sim.issueToken()),
      });
      expect(answer).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
      expect(seen).toEqual([]);
    },
  );
});

const lastBody = (method: string): Record<string, unknown> => {
  const request = sim.requests.filter((item) => item.method === method).at(-1);
  return JSON.parse(String(request?.body));
};

// The language parameter is an ISO 639-1 code (https://docs.joinmastodon.org/methods/statuses/ read 2026-11-27), so a
// BCP 47 tag is cut to its two-letter primary subtag and anything else is left out.
describe("a post's settings and locale reach the create body", () => {
  type Settings = Record<string, string | number | boolean>;
  const ROWS: [string, Settings, string | null, Record<string, unknown>][] = [
    ["the default visibility leaves the parameter out", { visibility: "default" }, null, {}],
    ["public", { visibility: "public" }, null, { visibility: "public" }],
    ["unlisted", { visibility: "unlisted" }, null, { visibility: "unlisted" }],
    ["private", { visibility: "private" }, null, { visibility: "private" }],
    ["sensitive", { sensitive: true }, null, { sensitive: true }],
    ["not sensitive leaves the parameter out", { sensitive: false }, null, {}],
    ["an Arabic content warning", { spoiler_text: "تحذير: محتوى" }, null, { spoiler_text: "تحذير: محتوى" }],
    ["an empty content warning leaves the parameter out", { spoiler_text: "" }, null, {}],
    ["ar-EG is sent as ar", {}, "ar-EG", { language: "ar" }],
    ["zh-Hant is sent as zh", {}, "zh-Hant", { language: "zh" }],
    ["en is sent as en", {}, "en", { language: "en" }],
    ["a null locale sends none", {}, null, {}],
    ["a three-letter or malformed tag sends none", {}, "fil-PH", {}],
    ["an empty tag sends none", {}, "", {}],
  ];
  const KEYS = ["visibility", "sensitive", "spoiler_text", "language"];
  it.each(ROWS)("%s", async (_name, settings, locale, expected) => {
    sim.reset();
    const { context } = recorder(sim);
    const answer = await adapter.commit(context, {
      idempotencyKey: "settings-1",
      text: "t",
      settings,
      locale,
      account: accountOf(sim.issueToken()),
    });
    expect(answer.ok).toBe(true);
    const body = lastBody("POST");
    const sent = KEYS.flatMap((key) => (key in body ? [[key, body[key]]] : []));
    expect(Object.fromEntries(sent)).toEqual(expected);
  });

  it.each([
    ["direct", { visibility: "direct" }],
    ["a visibility of the wrong type", { visibility: 1 }],
    ["an unknown visibility", { visibility: "friends" }],
  ])("%s is refused with no effect and no request", async (_name, settings) => {
    sim.reset();
    const { context, seen } = recorder(sim);
    const answer = await adapter.commit(context, {
      idempotencyKey: "settings-2",
      text: "t",
      settings,
      account: accountOf(sim.issueToken()),
    });
    expect(answer).toMatchObject({ ok: false, effect: "none", providerCode: "invalid_input" });
    expect(seen).toEqual([]);
  });
});

describe("a reply carries the id it answers and the root's visibility", () => {
  it("sends in_reply_to_id and a visibility other than the account default explicitly", async () => {
    const root = await seeded("reply-body-1");
    const answer = await adapter.commit(root.context, {
      idempotencyKey: "reply-body-2",
      text: "reply",
      replyToExternalId: root.id,
      settings: { visibility: "unlisted" },
      account: root.account,
    });
    expect(answer.ok).toBe(true);
    expect(lastBody("POST")).toMatchObject({ in_reply_to_id: root.id, visibility: "unlisted" });
  });
});

describe("an edit sends the whole of what the post says and never its visibility", () => {
  it("sends status, spoiler_text, sensitive and language, and changes the stored text", async () => {
    const post = await seeded("edit-body-1");
    const answer = await edit(post, {
      text: "second",
      settings: { visibility: "private", sensitive: false, spoiler_text: "" },
      locale: "ar-EG",
    });
    expect(answer).toMatchObject({ ok: true, effect: "confirmed", externalId: post.id });
    expect(lastBody("PUT")).toEqual({ status: "second", spoiler_text: "", sensitive: false, language: "ar" });
    expect(sim.stored().map((stored) => stored.text)).toEqual(["second"]);
  });
});

const TOKEN = "canary-token-status-1";
const TEXT = 'canary "text" status é';
const forms = (value: string) => [
  value,
  encodeURIComponent(value),
  Buffer.from(value).toString("hex"),
  Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
];

// The adapter has no logger of its own, so anything it or the shared call path prints reaches the console or the process
// streams; both are captured for the one call.
async function captured<T>(run: () => Promise<T> | undefined) {
  const logged: string[] = [];
  const keep = (chunk: unknown) => void logged.push(String(chunk));
  const spies = [
    ...(["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(keep),
    ),
    ...[process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        keep(chunk);
        return true;
      }),
    ),
  ];
  try {
    return { answer: await run(), logged };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("the token and the text are in no result, error or log line (floor)", () => {
  const FAULTS: [string, object | undefined][] = [
    ["a success", undefined],
    ["a 500", { kind: "respond", status: 500, body: { error: `boom ${TOKEN}` } }],
    ["a 401", { kind: "respond", status: 401, body: { error: `${TOKEN} ${TEXT}` } }],
    ["a 422", { kind: "respond", status: 422, body: { error: `Validation failed: ${TEXT}` } }],
  ];
  const CALLS = ["create", "edit", "reply"] as const;
  it.each(CALLS.flatMap((call) => FAULTS.map(([name, fault]) => [call, name, fault] as const)))(
    "%s with %s",
    async (call, _name, fault) => {
      sim.reset();
      const token = sim.issueToken();
      const { context } = recorder(sim);
      const account = { ...accountOf(token) };
      const base = { idempotencyKey: `canary-${call}`, text: TEXT, account };
      const made = await adapter.commit(context, { ...base, idempotencyKey: "canary-root" });
      const id = String(made.externalId);
      if (fault) sim.faults.failNext(call === "edit" ? EDIT : "POST /api/v1/statuses", fault as never);
      const { edit: editStatus } = adapter;
      if (call === "edit" && !editStatus) throw new Error("the adapter has no edit");
      const run = () =>
        call === "edit"
          ? editStatus?.(context, { externalId: id, account }, { text: TEXT })
          : adapter.commit(context, call === "reply" ? { ...base, replyToExternalId: id } : base);
      const { answer, logged } = await captured(run);
      expect(answer?.ok, "the call answered").toBeDefined();
      const shown = `${inspect(answer, { depth: null })} ${JSON.stringify(answer)} ${logged.join("\n")}`;
      for (const secret of [token, TOKEN, TEXT])
        for (const form of forms(secret)) expect(shown).not.toContain(form);
    },
  );
});
