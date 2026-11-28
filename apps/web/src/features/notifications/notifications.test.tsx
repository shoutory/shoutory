import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_WS,
  click,
  closeApp,
  json,
  openApp,
  refusal,
  settle,
  uuidWorkspaces,
} from "../../../test/support/app";
import { type ChannelApi, stubChannelApi } from "../../../test/support/channel-api";

afterEach(closeApp);

const PATH = `/w/${CONNECT_WS}/notifications`;
const SUBJECT = "0190a000-0000-7000-8000-0000000009a1";
const idOf = (n: number) => `0190a000-0000-7000-8000-00000000b${String(n).padStart(3, "0")}`;

const notice = (n: number, change: Record<string, unknown> = {}) => ({
  id: idOf(n),
  kind: "needs_human",
  subject_id: SUBJECT,
  level: "escalation_0",
  vars: { name: "Acme Page" },
  created_at: "2026-11-27T10:00:00.000Z",
  read_at: null,
  ...change,
});
const page = (rows: unknown[], next: string | null = null) =>
  json({ data: rows, meta: { next_cursor: next } });

async function visit(api: ChannelApi = {}, locale: "en" | "ar" = "en", path = PATH) {
  const stub = stubChannelApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(path, locale);
  await settle();
  return { stub, ...opened };
}
const state = (host: ParentNode) => host.querySelector<HTMLElement>('[data-testid="notices-state"]');
const rows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[data-testid="notice"]')];
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("the notices page", () => {
  it("is all caught up when there is nothing", async () => {
    const { host } = await visit({ notices: () => page([]) });
    expect(state(host)?.dataset.state).toBe("empty");
    expect(host.querySelector('[data-kind="cleared"] h2')?.textContent).toBe("You are all caught up");
  });

  it("shows a loading line while the first page is read", async () => {
    const { host } = await visit({ notices: () => new Promise<Response>(() => undefined) });
    expect(state(host)?.dataset.state).toBe("loading");
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it("says a failed read failed and reads again on Try again", async () => {
    let failing = true;
    const { host } = await visit({
      notices: () => (failing ? refusal("internal_error", 500) : page([notice(1)])),
    });
    expect(state(host)?.dataset.state).toBe("failed");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    failing = false;
    click(byId(host, "notices-retry") as HTMLElement);
    await settle();
    expect(rows(host)).toHaveLength(1);
  });

  it("answers a workspace that is not the person's with the not-found page and reads nothing", async () => {
    const other = "0190a000-0000-7000-8000-0000000000c2";
    const { host, stub } = await visit({}, "en", `/w/${other}/notifications`);
    expect(byId(host, "not-found")).not.toBeNull();
    expect(stub.mock.calls.filter(([url]) => url.includes("/notifications"))).toHaveLength(0);
  });

  it("links the rail to the page", async () => {
    const { host } = await visit({ notices: () => page([]) });
    expect(host.querySelector(`nav a[href="${PATH}"]`)).not.toBeNull();
  });
});

describe("one sentence and one next step per kind", () => {
  const home = `/w/${CONNECT_WS}`;
  it.each<[string, string, Record<string, unknown>, RegExp, string]>([
    [
      "token_expiry",
      "g1:14d",
      { name: "Acme Page" },
      /^Access to .*Acme Page.* ends in 14 days/,
      `${home}/channels`,
    ],
    ["token_expiry", "g2:1d", { name: "Acme Page", days: 1 }, /ends in 1 day\b/, `${home}/channels`],
    ["token_expiry", "g1:7d", {}, /^Access to a channel ends in 7 days/, `${home}/channels`],
    ["token_expiry", "g3:7d", { days: 3 }, /^Access to a channel ends in 3 days/, `${home}/channels`],
    [
      "reconnect_deadline",
      "g1:7d",
      { name: "Acme Page", days: 7 },
      /Acme Page.* is not connected\. Its waiting posts are kept for 7 more days/,
      `${home}/channels`,
    ],
    [
      "needs_human",
      "escalation_0",
      { name: "Acme Page" },
      /^A post to .*Acme Page.* needs your decision/,
      `${home}/posts`,
    ],
    ["unverified", "escalation_0", { name: "Acme Page" }, /Acme Page.* is not confirmed/, `${home}/posts`],
    ["held_media", "1d", { name: "Acme Page" }, /Acme Page.* is waiting for its media/, `${home}/posts`],
    [
      "drafts_day_30",
      "30d",
      { name: "Acme Page" },
      /Posts held for .*Acme Page.* are back in your drafts/,
      `${home}/posts/${SUBJECT}`,
    ],
  ])("%s at level %s", async (kind, level, vars, words, href) => {
    const { host } = await visit({ notices: () => page([notice(1, { kind, level, vars })]) });
    const [row] = rows(host);
    expect(row?.dataset.kind).toBe(kind);
    expect(row?.querySelector("p")?.textContent).toMatch(words);
    expect(row?.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-27T10:00:00.000Z");
  });
});

describe("reminders and links", () => {
  it.each([
    ["escalation_0", false],
    ["escalation_1", true],
    ["escalation_4", true],
  ])("a needs_human notice at %s is a reminder: %s", async (level, reminder) => {
    const { host } = await visit({ notices: () => page([notice(1, { level })]) });
    expect(rows(host)[0]?.querySelector("p")?.textContent?.startsWith("Reminder: ")).toBe(reminder);
  });

  it.each<[string, string, string]>([
    ["needs_human", "escalation_0", "منشور على ⁨Acme Page⁩ ينتظر قرارك."],
    ["needs_human", "escalation_2", "تذكير: منشور على ⁨Acme Page⁩ ينتظر قرارك."],
    ["unverified", "escalation_1", "تذكير: لم يتأكد نشر منشور على ⁨Acme Page⁩."],
  ])("a %s notice at %s reads as one Arabic sentence", async (kind, level, words) => {
    const { host } = await visit(
      {
        notices: () => page([notice(1, { kind, level, vars: { name: "Acme Page" } })]),
      },
      "ar",
    );
    expect(rows(host)[0]?.querySelector("p")?.textContent).toContain(words);
  });

  it("links a channel notice to the channels page, never by its credential subject", async () => {
    const { host } = await visit({
      notices: () => page([notice(1, { kind: "token_expiry", level: "g1:7d" })]),
    });
    expect(rows(host)[0]?.querySelector("a")?.getAttribute("href")).not.toContain(SUBJECT);
  });

  it("says plainly that a kind it does not know needs attention, with no link", async () => {
    const { host } = await visit({ notices: () => page([notice(1, { kind: "from_the_future" })]) });
    expect(rows(host)[0]?.querySelector("p")?.textContent).toBe("Something needs your attention.");
    expect(rows(host)[0]?.querySelector("a")).toBeNull();
  });
});

describe("Show more", () => {
  const first = () => page([notice(2), notice(1)], idOf(1));

  it("follows the cursor, appends the older page and goes away at the last page", async () => {
    const seen: (string | null)[] = [];
    const { host } = await visit({
      notices: (query) => {
        seen.push(query.get("cursor"));
        return query.get("cursor") === idOf(1) ? page([notice(0)]) : first();
      },
    });
    expect(rows(host)).toHaveLength(2);
    click(byId(host, "notices-more") as HTMLElement);
    await settle();
    expect(rows(host)).toHaveLength(3);
    expect(seen).toEqual([null, idOf(1)]);
    expect(byId(host, "notices-more")).toBeNull();
  });

  it("keeps the rows and says so when the next page fails", async () => {
    const { host } = await visit({
      notices: (query) => (query.get("cursor") === null ? first() : refusal("internal_error", 500)),
    });
    click(byId(host, "notices-more") as HTMLElement);
    await settle();
    expect(rows(host)).toHaveLength(2);
    expect(byId(host, "notices-more-error")?.getAttribute("role")).toBe("alert");
    expect(byId(host, "notices-more")).not.toBeNull();
  });
});

describe("in Arabic", () => {
  it("writes a notice in Arabic, with its name kept apart", async () => {
    const { host } = await visit({ notices: () => page([notice(1)]) }, "ar");
    const text = rows(host)[0]?.querySelector("p")?.textContent ?? "";
    expect(text).toContain("ينتظر قرارك");
    expect(text).not.toContain("needs your decision");
    expect(text).toContain("Acme Page");
  });
});
