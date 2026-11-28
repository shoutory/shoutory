import { afterEach, describe, expect, it } from "vitest";
import {
  click,
  closeApp,
  json,
  openApp,
  pick,
  refusal,
  settle,
  uuidWorkspaces,
} from "../../../test/support/app";
import {
  CHANNEL_ONE,
  CHANNEL_TWO,
  listRow,
  listTarget,
  POST_WS,
  type PostApi,
  postId,
  stubPostApi,
  variantId,
} from "../../../test/support/post-api";

afterEach(closeApp);

const PATH = `/w/${POST_WS}/posts`;
const page = (rows: unknown[], next: string | null = null) =>
  json({ data: rows, meta: { next_cursor: next } });

async function visit(api: PostApi = {}, locale: "en" | "ar" = "en", path = PATH) {
  const stub = stubPostApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(path, locale);
  await settle();
  return { stub, ...opened };
}
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const state = (host: ParentNode) => byId(host, "posts-state")?.dataset.state;
const listCalls = (stub: ReturnType<typeof stubPostApi>) =>
  stub.mock.calls
    .map(([url]) => new URL(url, "http://same-origin.invalid"))
    .filter((url) => url.pathname.endsWith("/posts"));

const target = (n: number, change: Record<string, unknown> = {}) =>
  listTarget({ variant_id: variantId(n), ...change });

describe("the posts list rows", () => {
  it("shows the excerpt as a link to the post, the author kind and the status word of each target", async () => {
    const { host } = await visit({
      postList: () => page([listRow(1, { excerpt: "Launch day <b>text</b>" })]),
    });
    const [row] = all(host, "post-row");
    const link = row?.querySelector<HTMLAnchorElement>("a");
    expect(link?.getAttribute("href")).toBe(`${PATH}/${postId(1)}`);
    expect(link?.textContent).toBe("Launch day <b>text</b>");
    expect(row?.querySelector("b")).toBeNull();
    expect(row?.textContent).toContain("Member");
    expect(row?.textContent).toContain("Acme Page");
    expect(row?.textContent).toContain("Published");
  });
});

const WORD_ROWS: [string, Record<string, unknown>, string, string][] = [
  ["pending", { operation_state: "pending", published_at: null }, "Waiting for its time", "بانتظار موعده"],
  ["claimed", { operation_state: "claimed", published_at: null }, "Getting ready", "جارٍ التحضير"],
  ["dispatching", { operation_state: "dispatching", published_at: null }, "Sending", "جارٍ الإرسال"],
  [
    "processing",
    { operation_state: "processing", published_at: null },
    "Fixture Network is preparing the media",
    "Fixture Network تجهّز الوسائط",
  ],
  [
    "provider_accepted",
    { operation_state: "provider_accepted", published_at: null },
    "Accepted by Fixture Network, finishing",
    "قبلته Fixture Network وتُنهيه الآن",
  ],
  ["retry_wait", { operation_state: "retry_wait", published_at: null }, "Will retry", "ستُعاد المحاولة"],
  ["paused", { operation_state: "paused", published_at: null }, "Paused", "متوقف مؤقتًا"],
  [
    "blocked_reconnect",
    { operation_state: "blocked_reconnect", published_at: null },
    "Held: reconnect Acme Page",
    "محجوز: أعد ربط Acme Page",
  ],
  [
    "unknown_external_state",
    { operation_state: "unknown_external_state", published_at: null },
    "Checking whether it was posted",
    "نتحقق مما إذا كان قد نُشر",
  ],
  [
    "reconciling",
    { operation_state: "reconciling", published_at: null },
    "Checking Fixture Network now",
    "نراجع Fixture Network الآن",
  ],
  [
    "needs_human",
    { operation_state: "needs_human", published_at: null },
    "Needs your check",
    "يحتاج إلى تحققك",
  ],
  [
    "unverified",
    { operation_state: "unverified", published_at: null },
    "Could not be confirmed",
    "تعذّر التأكد",
  ],
  ["published", {}, "Published", "نُشر"],
  ["failed", { operation_state: "failed", published_at: null }, "Failed", "فشل"],
  ["cancelled", { operation_state: "cancelled", published_at: null }, "Cancelled", "أُلغي"],
  ["missed", { operation_state: "missed", published_at: null }, "Missed", "فات موعده"],
  [
    "superseded_after_unknown_outcome",
    { operation_state: "superseded_after_unknown_outcome", published_at: null },
    "Replaced after an unclear result",
    "استُبدل بعد نتيجة غير واضحة",
  ],
  [
    "a removal under way",
    { presence: "removal_pending" },
    "Removing from Fixture Network",
    "جارٍ الحذف من Fixture Network",
  ],
  [
    "a removal that could not be confirmed",
    { presence: "removal_unknown" },
    "We could not confirm it was removed",
    "لم نتأكد من الحذف",
  ],
  [
    "a draft with no operation yet",
    { operation_state: null, schedule_state: "draft", published_at: null },
    "Draft",
    "مسودة",
  ],
];

describe("the status words", () => {
  it.each(WORD_ROWS)(
    "the word of a target in state %s is its status word in English and Arabic",
    async (_name, change, en, ar) => {
      const api = { postList: () => page([listRow(1, { status: "draft", targets: [target(1, change)] })]) };
      const english = await visit(api);
      expect(all(english.host, "post-target")[0]?.textContent).toContain(en);
      closeApp();
      const arabic = await visit(api, "ar");
      expect(all(arabic.host, "post-target")[0]?.textContent).toContain(ar);
    },
  );
});

describe("the summary of a row", () => {
  it.each<[string, unknown[], string | null]>([
    ["one target of one", [target(1)], null],
    ["four targets of four", [1, 2, 3, 4].map((n) => target(n)), "4 of 4 published"],
    [
      "two of four published",
      [
        target(1),
        target(2),
        target(3, { operation_state: "pending", published_at: null }),
        target(4, { operation_state: "failed", published_at: null }),
      ],
      "2 of 4 published",
    ],
    [
      "one published and one being removed",
      [target(1), target(2, { presence: "removal_pending" })],
      "1 of 2 published",
    ],
  ])("%s", async (_name, targets, line) => {
    const { host } = await visit({ postList: () => page([listRow(1, { targets })]) });
    const summary = byId(host, "post-summary");
    if (line === null) expect(summary).toBeNull();
    else expect(summary?.textContent).toContain(line);
  });
});

describe("the headline of a row", () => {
  it.each<[string, Record<string, unknown>[], string]>([
    ["every target live", [{}, {}], "Published"],
    ["one still waiting", [{}, { operation_state: "pending", published_at: null }], "Scheduled"],
    ["one needing a check", [{}, { operation_state: "needs_human", published_at: null }], "Needs attention"],
    ["one failed", [{}, { operation_state: "failed", published_at: null }], "Partly published"],
    ["all failed", [{ operation_state: "failed", published_at: null }], "Failed"],
    ["all missed", [{ operation_state: "missed", published_at: null }], "Missed"],
    ["one sending", [{}, { operation_state: "dispatching", published_at: null }], "Publishing"],
  ])("the headline with %s is %s, and Published only with every target live", async (_n, changes, word) => {
    const targets = changes.map((change, n) => target(n + 1, change));
    const { host } = await visit({ postList: () => page([listRow(1, { targets })]) });
    expect(byId(host, "post-headline")?.textContent).toBe(word);
  });
});

describe("the time and the attention badge of a row", () => {
  it("shows when it goes out with the zone named, and when it was published otherwise", async () => {
    const waiting = target(1, {
      operation_state: "pending",
      published_at: null,
      schedule_state: "scheduled",
      due_at: "2026-12-01T07:00:00.000Z",
      due_tz: "Africa/Cairo",
    });
    const { host } = await visit({
      postList: () => page([listRow(1, { status: "scheduled", targets: [waiting] }), listRow(2)]),
    });
    const [first, second] = all(host, "post-row");
    expect(first?.textContent).toMatch(/Goes out .*2026.*GMT\+2/);
    expect(second?.textContent).toMatch(/Published .*2026/);
  });

  it.each<[string, Record<string, unknown>[], boolean]>([
    ["a target needing a check", [{ operation_state: "needs_human", published_at: null }], true],
    ["a target that could not be confirmed", [{ operation_state: "unverified", published_at: null }], true],
    ["a missed target", [{ operation_state: "missed", published_at: null }], true],
    ["a held target", [{ operation_state: "blocked_reconnect", published_at: null }], true],
    ["a target held for its media", [{ operation_state: "pending", hold_reason: "held_media" }], true],
    ["a published target", [{}], false],
    ["a waiting target", [{ operation_state: "pending", published_at: null }], false],
  ])("the attention badge for %s is %s", async (_name, changes, shown) => {
    const targets = changes.map((change, n) => target(n + 1, change));
    const { host } = await visit({ postList: () => page([listRow(1, { targets })]) });
    expect(byId(host, "post-attention") !== null).toBe(shown);
  });
});

describe("the filters", () => {
  it("asks the server for the chosen status", async () => {
    const { host, stub } = await visit({ postList: () => page([listRow(1)]) });
    pick(host, "Show", "Missed");
    await settle();
    expect(listCalls(stub).at(-1)?.searchParams.get("status")).toBe("missed");
    expect(host.querySelector('[data-testid="posts-filter"]')?.textContent).toContain("Missed");
  });

  it("Needs attention reads the newest posts in pages and lists only the rows that need a person", async () => {
    const needs = [{ operation_state: "needs_human", published_at: null }];
    const missed = target(1, { operation_state: "missed", published_at: null });
    const { host, stub } = await visit({
      postList: (query) =>
        query.get("cursor") === "cursor-1"
          ? page([listRow(3, { targets: [missed] })])
          : page([listRow(1), listRow(2, { targets: [target(1, needs[0])] })], "cursor-1"),
    });
    pick(host, "Show", "Needs attention");
    await settle();
    expect(all(host, "post-row").map((one) => one.dataset.postId)).toEqual([postId(2), postId(3)]);
    const calls = listCalls(stub).slice(1);
    expect(calls.map((url) => url.searchParams.get("limit"))).toEqual(["100", "100"]);
    expect(calls[1]?.searchParams.get("cursor")).toBe("cursor-1");
    expect(calls.every((url) => url.searchParams.get("status") === null)).toBe(true);
    expect(byId(host, "posts-checked-note")).toBeNull();
  });

  it("Needs attention says how many posts it checked when the posts did not end within its bound", async () => {
    let made = 0;
    const { host, stub } = await visit({
      postList: () => {
        made += 1;
        return page([listRow(made)], `cursor-${made}`);
      },
    });
    pick(host, "Show", "Needs attention");
    await settle();
    expect(listCalls(stub)).toHaveLength(6);
    expect(byId(host, "posts-checked-note")?.textContent).toMatch(/newest 5 posts/);
  });

  it("an empty Needs attention says nothing needs you, positively", async () => {
    const { host } = await visit({ postList: () => page([listRow(1)]) });
    pick(host, "Show", "Needs attention");
    await settle();
    expect(state(host)).toBe("cleared");
    expect(host.querySelector('[data-kind="cleared"] h2')?.textContent).toBe("Nothing needs you");
  });
});

describe("the empty kinds", () => {
  it("first use says no posts yet and offers New post, which opens the composer", async () => {
    const { host, router } = await visit();
    expect(state(host)).toBe("empty");
    expect(host.querySelector('[data-kind="first-use"] h2')?.textContent).toBe("No posts yet");
    click(byId(host, "posts-empty-new") as HTMLElement);
    await settle();
    expect(router.state.location.pathname).toBe(`${PATH}/new`);
  });

  it("a status with no posts is filtered-out, and Clear filters shows every post again", async () => {
    const { host } = await visit({
      postList: (query) => page(query.get("status") === null ? [listRow(1)] : []),
    });
    pick(host, "Show", "Failed");
    await settle();
    expect(state(host)).toBe("filtered");
    expect(host.querySelector('[data-kind="filtered-out"] h2')?.textContent).toBe(
      "No posts match these filters",
    );
    click(
      [...host.querySelectorAll<HTMLElement>('[data-kind="filtered-out"] button')].find((one) =>
        one.textContent?.includes("Clear filters"),
      ) as HTMLElement,
    );
    await settle();
    expect(all(host, "post-row")).toHaveLength(1);
  });
});

describe("reading the list", () => {
  it("Show more appends the next page once and drops a post both pages hold", async () => {
    let read = 0;
    const { host, stub } = await visit({
      postList: () =>
        read++ === 0 ? page([listRow(1), listRow(2)], "cursor-1") : page([listRow(2), listRow(3)]),
    });
    click(byId(host, "posts-more") as HTMLElement);
    click(byId(host, "posts-more") ?? document.body);
    await settle();
    expect(all(host, "post-row")).toHaveLength(3);
    expect(byId(host, "posts-more")).toBeNull();
    expect(listCalls(stub)).toHaveLength(2);
    expect(listCalls(stub)[1]?.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("a failed Show more keeps the rows and says so", async () => {
    let read = 0;
    const { host } = await visit({
      postList: () => (read++ === 0 ? page([listRow(1)], "cursor-1") : refusal("internal_error", 500)),
    });
    click(byId(host, "posts-more") as HTMLElement);
    await settle();
    expect(all(host, "post-row")).toHaveLength(1);
    expect(byId(host, "posts-more-error")?.textContent).toMatch(/could not load more/i);
  });

  it("a failed read shows the panel with its request id and reads again on Try again", async () => {
    let failing = true;
    const { host } = await visit({
      postList: () => (failing ? refusal("internal_error", 500) : page([listRow(1)])),
    });
    expect(state(host)).toBe("failed");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("We could not load your posts");
    expect(host.textContent).toContain("req-42");
    expect(host.textContent).not.toContain("words the user must never see");
    failing = false;
    click(byId(host, "posts-retry") as HTMLElement);
    await settle();
    expect(all(host, "post-row")).toHaveLength(1);
  });

  it("a slow first read shows placeholder rows after 300 ms, not before", async () => {
    const { host } = await visit({ postList: () => new Promise<Response>(() => undefined) });
    expect(byId(host, "posts-skeleton")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(byId(host, "posts-skeleton")).not.toBeNull();
  });
});

describe("what the list does not know or may not show", () => {
  it("a role that cannot see posts gets the page for a refused screen", async () => {
    const { host } = await visit({ postList: () => refusal("forbidden", 403) });
    expect(host.querySelector("h1")?.textContent).toMatch(/do not have access/i);
  });

  it("names a channel the list does not know by a plain word, never its id", async () => {
    const stranger = target(1, { channel_id: "0190a000-0000-7000-8000-0000000000dd" });
    const { host } = await visit({ postList: () => page([listRow(1, { targets: [stranger] })]) });
    expect(all(host, "post-target")[0]?.textContent).toContain("a channel");
    expect(host.textContent).not.toContain("0190a000-0000-7000-8000-0000000000dd");
  });

  it("two channels of one post are two target lines in order", async () => {
    const targets = [
      target(1),
      target(2, { channel_id: CHANNEL_TWO, operation_state: "failed", published_at: null }),
    ];
    const { host } = await visit({ postList: () => page([listRow(1, { targets })]) });
    const lines = all(host, "post-target").map((one) => one.textContent ?? "");
    expect(lines[0]).toContain("Acme Page");
    expect(lines[1]).toContain("Acme Shop");
    expect(CHANNEL_ONE).not.toBe(CHANNEL_TWO);
  });
});

describe("the navigation", () => {
  it("offers Posts and New post in the rail to a role that can edit", async () => {
    const { host } = await visit();
    expect(host.querySelector(`nav a[href="${PATH}"]`)?.textContent).toBe("Posts");
    expect(host.querySelector(`nav a[href="${PATH}/new"]`)?.textContent).toBe("New post");
  });
});
