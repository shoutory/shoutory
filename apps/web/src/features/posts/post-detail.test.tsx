import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeApp, openApp, refusal, settle, uuidWorkspaces } from "../../../test/support/app";
import {
  CHANNEL_ONE,
  CHANNEL_THREE,
  CHANNEL_TWO,
  detailAnswer,
  detailTarget,
  operation,
  POST_WS,
  type PostApi,
  postId,
  stubPostApi,
  variantId,
} from "../../../test/support/post-api";

afterEach(closeApp);

const PATH = `/w/${POST_WS}/posts/${postId(1)}`;

async function visit(api: PostApi = {}, locale: "en" | "ar" = "en") {
  const stub = stubPostApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH, locale);
  await settle();
  return { stub, ...opened };
}
const showing = (...targets: unknown[]): PostApi => ({ postDetail: () => detailAnswer(targets) });
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const text = (host: ParentNode, id: string) => byId(host, id)?.textContent;
const waiting = {
  published_at: null,
  schedule_state: "scheduled",
  due_at: "2026-12-01T09:00:00.000Z",
  due_tz: "UTC",
  operation: operation({ state: "pending", effect: "none" }),
};
const target = (n: number, change: Record<string, unknown> = {}) =>
  detailTarget({ variant_id: variantId(n), ...change });
const inState = (state: string, change: Record<string, unknown> = {}, effect = "none") => ({
  published_at: null,
  operation: operation({ state, effect, ...change }),
});

const WORDS: [string, Record<string, unknown>, string, string, string][] = [
  ["pending", waiting, "Waiting for its time", "بانتظار موعده", "Goes out"],
  ["claimed", inState("claimed"), "Getting ready", "جارٍ التحضير", "Preparing to send"],
  ["dispatching", inState("dispatching"), "Sending", "جارٍ الإرسال", "Being sent to Fixture Network"],
  [
    "provider_accepted",
    inState("provider_accepted"),
    "Accepted by Fixture Network, finishing",
    "قبلته Fixture Network وتُنهيه الآن",
    "we are confirming",
  ],
  ["retry_wait", inState("retry_wait"), "Will retry", "ستُعاد المحاولة", "Nothing was posted yet."],
  [
    "paused",
    inState("paused", { reason_code: "quota" }),
    "Paused: quota reached",
    "متوقف مؤقتًا: بلوغ الحصة",
    "We will continue",
  ],
  [
    "blocked_reconnect",
    { ...inState("blocked_reconnect"), channel_id: CHANNEL_THREE },
    "Held: reconnect Acme Blog",
    "محجوز: أعد ربط Acme Blog",
    "Reconnect by",
  ],
  [
    "unknown_external_state",
    inState("unknown_external_state", {}, "possible"),
    "Checking whether it was posted",
    "نتحقق مما إذا كان قد نُشر",
    "we have not posted again",
  ],
  [
    "needs_human",
    inState("needs_human", {}, "possible"),
    "Needs your check",
    "يحتاج إلى تحققك",
    "could not confirm this",
  ],
  [
    "needs_human past due",
    inState("needs_human", { reason_code: "past_due_after_reconnect" }),
    "Nothing was posted; its time passed",
    "لم يُنشر شيء؛ فات موعده",
    "Posting now would be late",
  ],
  [
    "unverified",
    inState("unverified", {}, "possible"),
    "Could not be confirmed",
    "تعذّر التأكد",
    "still blocks new posts",
  ],
  ["failed, nothing sent", inState("failed"), "Failed", "فشل", "Nothing was posted to Acme Page"],
  [
    "failed, a thread part",
    inState("failed", { part_index: 3 }),
    "Failed",
    "فشل",
    "Parts 1 to 3 are live; part 4 was not posted",
  ],
  ["missed", inState("missed"), "Missed", "فات موعده", "we never send late"],
  ["cancelled", inState("cancelled"), "Cancelled", "أُلغي", "cancelled before anything was sent"],
  [
    "an edit being sent",
    { operation: operation({ kind: "edit", state: "dispatching" }) },
    "Applying your edit",
    "جارٍ تطبيق تعديلك",
    "still show the old text",
  ],
  [
    "an edit that failed",
    { operation: operation({ kind: "edit", state: "failed" }) },
    "Edit not applied",
    "لم يُطبَّق التعديل",
    "earlier text",
  ],
  [
    "a removal under way",
    { presence: "removal_pending", operation: operation({ kind: "delete", state: "dispatching" }) },
    "Removing from Fixture Network",
    "جارٍ الحذف من Fixture Network",
    "We are confirming",
  ],
  [
    "a removal not confirmed",
    { presence: "removal_unknown", operation: operation({ kind: "delete", state: "needs_human" }) },
    "We could not confirm it was removed",
    "لم نتأكد من الحذف",
    "Open Fixture Network",
  ],
];

describe("the word and meaning of each target", () => {
  it.each(WORDS)("%s", async (_name, change, en, ar, meaning) => {
    const api = showing(target(1, change));
    const english = await visit(api);
    expect(text(english.host, "target-word")).toContain(en);
    expect(text(english.host, "target-meaning")).toContain(meaning);
    closeApp();
    const arabic = await visit(api, "ar");
    expect(text(arabic.host, "target-word")).toContain(ar);
  });
});

const live = (n: number) => target(n);
const sending = (n: number) => target(n, inState("dispatching"));
const check = (n: number) => target(n, inState("needs_human", {}, "possible"));
const failed = (n: number) => target(n, inState("failed"));

describe("the headline", () => {
  it.each<[string, unknown[], string, string]>([
    ["one live target", [live(1)], "Published", "1 of 1 published"],
    ["four live targets", [1, 2, 3, 4].map(live), "Published", "4 of 4 published"],
    ["a target needing a check", [live(1), check(2)], "Needs attention", "1 of 2 published"],
    ["a target still sending", [live(1), sending(2)], "Publishing", "1 of 2 published"],
    ["a target still waiting", [live(1), target(2, waiting)], "Scheduled", "1 of 2 published"],
    ["one failed", [live(1), live(2), live(3), failed(4)], "Partly published", "3 of 4 published"],
    ["every one failed", [failed(1), failed(2)], "Failed", "0 of 2 published"],
    ["every one missed", [target(1, inState("missed"))], "Missed", "0 of 1 published"],
  ])("with %s reads %s and %s", async (_name, targets, headline, summary) => {
    const { host } = await visit(showing(...targets));
    expect(text(host, "post-headline")).toBe(headline);
    expect(text(host, "post-summary")).toContain(summary);
  });

  it("is never Published while a target was delivered as a draft, and counts it as not live", async () => {
    const draft = target(2, {
      operation: operation({ state: "published" }),
      evidence: [
        {
          kind: "accepted",
          level: "receipt",
          outcome_kind: "draft_delivered",
          permalink: null,
          observed_at: "2026-11-27T10:00:00.000Z",
        },
      ],
    });
    const { host } = await visit(showing(live(1), draft));
    expect(text(host, "post-headline")).toBe("Published, 1 not live");
    expect(text(host, "post-summary")).toContain("1 of 2 published, 1 not live");
  });

  it("shows the number in Arabic with the same words", async () => {
    const { host } = await visit(showing(live(1), failed(2)), "ar");
    expect(text(host, "post-headline")).toBe("نُشر جزئيًا");
    expect(text(host, "post-summary")).toContain("نُشر 1 من 2");
  });
});

describe("the media hold", () => {
  it("says a target is waiting for its media, in both languages", async () => {
    const held = target(1, { ...waiting, schedule_state: "scheduled", hold_reason: "held_media" });
    const english = await visit(showing(held));
    expect(text(english.host, "target-hold")).toContain("Waiting for its media");
    closeApp();
    const arabic = await visit(showing(held), "ar");
    expect(text(arabic.host, "target-hold")).toContain("بانتظار الوسائط");
  });

  it("says nothing when the answer has no hold reason", async () => {
    const { host } = await visit(showing(target(1, waiting)));
    expect(byId(host, "target-hold")).toBeNull();
  });
});

const evidence = (level: string, change: Record<string, unknown> = {}) => ({
  kind: "verified",
  level,
  outcome_kind: "post",
  permalink: null,
  observed_at: "2026-11-27T10:00:00.000Z",
  ...change,
});

describe("evidence and attempts", () => {
  it.each<[string, unknown[], string]>([
    ["a receipt", [evidence("receipt")], "Confirmed by Fixture Network's answer"],
    ["a read back", [evidence("read_back")], "Confirmed by reading the post back"],
    ["a person", [evidence("human", { kind: "human_confirmed" })], "Confirmed by you"],
    [
      "a read back, then a newer receipt: the stronger one stays",
      [evidence("receipt", { observed_at: "2026-11-27T12:00:00.000Z" }), evidence("read_back")],
      "Confirmed by reading the post back",
    ],
    [
      "a person's word, then a newer receipt: the receipt is stronger",
      [evidence("receipt", { observed_at: "2026-11-27T12:00:00.000Z" }), evidence("human")],
      "Confirmed by Fixture Network's answer",
    ],
  ])("the evidence line for %s", async (_name, list, line) => {
    const { host } = await visit(showing(target(1, { evidence: list })));
    expect(text(host, "target-evidence")).toBe(line);
  });

  it("shows no evidence line and no attempts when the answer carries neither", async () => {
    const { host } = await visit(showing(target(1)));
    expect(byId(host, "target-evidence")).toBeNull();
    expect(byId(host, "target-attempts")).toBeNull();
  });

  it("shows the attempts of an owner's answer, newest first", async () => {
    const attempts = [3, 2, 1].map((n) => ({
      attempt_no: n,
      step: "commit",
      effect: n === 3 ? "confirmed" : "none",
      http_status: n === 3 ? 200 : 503,
      error_class: n === 3 ? null : "unavailable",
      started_at: "2026-11-27T10:00:00.000Z",
      finished_at: "2026-11-27T10:00:05.000Z",
    }));
    const { host } = await visit(showing(target(1, { evidence: [], attempts })));
    const rows = all(host, "attempt");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Attempt 3");
    expect(rows[1]?.textContent).toContain("503");
  });
});

describe("the link to the post", () => {
  const withLink = (permalink: string) =>
    showing(target(1, { evidence: [evidence("receipt", { permalink })] }));

  it("links an https address with rel and a new tab, the address escaped", async () => {
    const { host } = await visit(withLink('https://example.test/p?a=1&b="<i>x</i>"'));
    const link = byId(host, "target-link") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/example\.test\/p\?a=1&b=/);
    expect(host.querySelector("i")).toBeNull();
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<b>x</b>"],
    ["ftp://example.test/x"],
    ["not an address"],
  ])("shows %s as plain text, never as a link", async (permalink) => {
    const { host } = await visit(withLink(permalink));
    const shown = byId(host, "target-link");
    expect(shown?.tagName).not.toBe("A");
    expect(shown?.textContent).toContain(permalink);
    expect(host.querySelector('a[href^="javascript"], a[href^="data"], a[href^="ftp"]')).toBeNull();
  });
});

describe("the settings", () => {
  it("shows every key and value, defaults included, in each kind of value", async () => {
    const settings = {
      audience: "everyone",
      reply_limit: 3,
      hashtags: true,
      link_preview: null,
      tags: ["a", "b"],
    };
    const { host } = await visit(showing(target(1, { settings })));
    const shown = byId(host, "target-settings")?.textContent ?? "";
    for (const part of [
      "audience",
      "everyone",
      "reply limit",
      "3",
      "hashtags",
      "Yes",
      "link preview",
      "Not set",
    ]) {
      expect(shown).toContain(part);
    }
    expect(shown).toContain('["a","b"]');
  });

  it("says when a channel has no settings", async () => {
    const { host } = await visit(showing(target(1, { settings: {} })));
    expect(text(host, "target-settings")).toContain("No settings");
  });
});

const CANARY = 'web-canary"v\\1/a b+c=d';
const SPELLINGS = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY).toString("hex"),
  Buffer.from(CANARY).toString("base64"),
  JSON.stringify(CANARY).slice(1, -1),
];

describe("what never reaches the screen", () => {
  it.each(
    SPELLINGS.map((spelling, n) => [
      ["raw", "percent-encoded", "hex", "base64", "JSON-escaped"][n],
      spelling,
    ]),
  )("a provider's words and a token are not shown, %s", async (_form, spelling) => {
    const planted = { error_body: CANARY, access_token: CANARY, provider_message: CANARY };
    const row = target(1, {
      ...planted,
      operation: operation({ state: "failed", effect: "none", reason_code: CANARY, ...planted }),
      evidence: [evidence("receipt", planted)],
      attempts: [
        {
          attempt_no: 1,
          step: "commit",
          effect: "none",
          http_status: 500,
          error_class: "unavailable",
          started_at: "2026-11-27T10:00:00.000Z",
          finished_at: null,
          ...planted,
        },
      ],
    });
    const { host } = await visit(showing(row));
    expect(host.innerHTML).not.toContain(spelling);
    expect(host.textContent).not.toContain(spelling);
  });
});

describe("reading the post", () => {
  it("a slow first read shows a placeholder after 300 ms, not before", async () => {
    const { host } = await visit({ postDetail: () => new Promise<Response>(() => undefined) });
    expect(byId(host, "post-skeleton")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(byId(host, "post-skeleton")).not.toBeNull();
  });

  it("a failed read shows the panel with its request id and reads again on Try again", async () => {
    let failing = true;
    const { host } = await visit({
      postDetail: () => (failing ? refusal("internal_error", 500) : detailAnswer([target(1)])),
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("We could not load this post");
    expect(host.textContent).toContain("req-42");
    failing = false;
    act(() => byId(host, "post-retry")?.click());
    await settle();
    expect(byId(host, "post-headline")).not.toBeNull();
  });

  it("a post that is not there shows the not-found page", async () => {
    const { host } = await visit({ postDetail: () => refusal("not_found", 404) });
    expect(byId(host, "not-found")).not.toBeNull();
  });

  it("names the channel and the platform of each target, never an id", async () => {
    const { host } = await visit(showing(target(1), target(2, { channel_id: CHANNEL_TWO })));
    const rows = all(host, "post-target").map((one) => one.textContent ?? "");
    expect(rows[0]).toContain("Acme Page");
    expect(rows[1]).toContain("Acme Shop");
    expect(host.textContent).not.toContain(CHANNEL_ONE);
  });
});

const detailCalls = (stub: ReturnType<typeof stubPostApi>) =>
  stub.mock.calls.filter(([url, init]) => url.endsWith(postId(1)) && (init?.method ?? "GET") === "GET");

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("polling while a target is not finished", () => {
  it("reads again every 5 seconds while a target is sending, and stops when every target is finished", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    const { stub } = await visit({
      postDetail: () => detailAnswer([++reads < 3 ? target(1, inState("dispatching")) : target(1)]),
    });
    expect(detailCalls(stub)).toHaveLength(1);
    await tick(4900);
    expect(detailCalls(stub)).toHaveLength(1);
    await tick(200);
    expect(detailCalls(stub)).toHaveLength(2);
    await tick(5000);
    expect(detailCalls(stub)).toHaveLength(3);
    await tick(30000);
    expect(detailCalls(stub)).toHaveLength(3);
  });

  it.each<[string, Record<string, unknown>]>([
    ["published", {}],
    ["failed", inState("failed")],
    ["cancelled", inState("cancelled")],
    ["missed", inState("missed")],
    ["replaced", inState("superseded_after_unknown_outcome")],
    ["a draft", { published_at: null, schedule_state: "draft", operation: null }],
  ])("does not poll when the only target is %s", async (_name, change) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub } = await visit(showing(target(1, change)));
    await tick(30000);
    expect(detailCalls(stub)).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ["waiting", waiting],
    ["needing a check", inState("needs_human", {}, "possible")],
    ["not confirmed", inState("unverified", {}, "possible")],
    ["held", inState("blocked_reconnect")],
    [
      "being removed",
      { presence: "removal_pending", operation: operation({ kind: "delete", state: "published" }) },
    ],
  ])("keeps polling while the target is %s", async (_name, change) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub } = await visit(showing(target(1, change)));
    await tick(5100);
    await tick(5100);
    expect(detailCalls(stub)).toHaveLength(3);
  });
});

describe("when polling waits", () => {
  it("does not poll in a hidden tab, and reads at once when the tab shows again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const { stub } = await visit(showing(target(1, waiting)));
    await tick(20000);
    expect(detailCalls(stub)).toHaveLength(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(detailCalls(stub)).toHaveLength(2);
    Reflect.deleteProperty(document, "hidden");
  });

  it("never starts a read while one is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    const { stub } = await visit({
      postDetail: () => {
        reads += 1;
        return reads === 1 ? detailAnswer([target(1, waiting)]) : new Promise<Response>(() => undefined);
      },
    });
    await tick(20000);
    expect(detailCalls(stub)).toHaveLength(2);
  });

  it("keeps the rows and says the refresh failed when a poll fails, then recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    const { host } = await visit({
      postDetail: () => (++reads === 2 ? refusal("internal_error", 500) : detailAnswer([target(1, waiting)])),
    });
    await tick(5100);
    expect(text(host, "post-refresh-note")).toContain("could not refresh");
    expect(all(host, "post-target")).toHaveLength(1);
    await tick(5100);
    expect(byId(host, "post-refresh-note")).toBeNull();
  });
});
