import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, json, openApp, settle } from "../../../test/support/app";
import {
  allById,
  byId,
  CH,
  callsOf,
  detailOf,
  POST,
  stubComposerApi,
  typeInto,
  VERSION_2,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(closeApp);

const parts = (...texts: string[]) => texts.map((text) => ({ kind: "thread_reply", text }));

async function open(channel: string, variant: Record<string, unknown> = {}) {
  const stub = stubComposerApi({
    answer: (call) => {
      if (call.method === "GET" && call.path === `posts/${POST}`) {
        return detailOf([variantRow(channel, "Opening post", variant)]);
      }
      if (call.method === "PATCH")
        return json({ data: { id: POST, version_id: VERSION_2, pending_changes: [] } });
      return undefined;
    },
  });
  await openApp(`/w/w1/posts/${POST}/edit`);
  await settle();
  await click(allById("tab-channel")[0] as HTMLElement);
  await settle();
  return stub;
}

const texts = () => allById("part-text").map((one) => (one as HTMLTextAreaElement).value);

describe("which channels get the builders", () => {
  it.each<[string, string, boolean, boolean]>([
    ["a channel that posts threads and follow-ups", CH.thread, true, true],
    ["a channel that does neither", CH.short, false, false],
  ])("%s", async (_name, channel, thread, comment) => {
    await open(channel);
    expect(byId("part-add") !== null).toBe(thread);
    expect(byId("first-comment") !== null).toBe(comment);
  });
});

describe("the parts of a thread", () => {
  it("adds, moves and removes parts with buttons, never only by dragging", async () => {
    await open(CH.thread, { parts: parts("one", "two", "three") });
    expect(texts()).toEqual(["one", "two", "three"]);
    await click(allById("part-down")[0] as HTMLElement);
    await settle();
    expect(texts()).toEqual(["two", "one", "three"]);
    await click(allById("part-up")[2] as HTMLElement);
    await settle();
    expect(texts()).toEqual(["two", "three", "one"]);
    await click(allById("part-delete")[1] as HTMLElement);
    await settle();
    expect(texts()).toEqual(["two", "one"]);
    await click(byId("part-add") as HTMLElement);
    await settle();
    expect(texts()).toEqual(["two", "one", ""]);
  });

  it.each<[string, string, number, string, number]>([
    ["down", "part-down", 0, "part-down", 1],
    ["up", "part-up", 2, "part-up", 1],
  ])(
    "moving a part %s says where it is now and keeps focus on it",
    async (_name, button, from, again, to) => {
      await open(CH.thread, { parts: parts("one", "two", "three") });
      const live = byId("parts-live");
      expect(live?.getAttribute("role")).toBe("status");
      const pressed = allById(button)[from] as HTMLElement;
      pressed.focus();
      await click(pressed);
      await settle();
      expect(byId("parts-live")).toBe(live);
      expect(live?.textContent).toBe(`Part moved to position ${to + 1} of 3`);
      expect(document.activeElement).toBe(allById(again)[to]);
    },
  );
});

describe("deleting parts", () => {
  it.each<[string, number, string[], number]>([
    ["a middle part", 1, ["one", "three"], 0],
    ["the first part", 0, ["two", "three"], 0],
    ["the last part", 2, ["one", "two"], 1],
  ])("deleting %s moves focus to the part before it", async (_name, at, left, focused) => {
    await open(CH.thread, { parts: parts("one", "two", "three") });
    await click(allById("part-delete")[at] as HTMLElement);
    await settle();
    expect(texts()).toEqual(left);
    expect(document.activeElement).toBe(allById("part-text")[focused]);
  });

  it("deleting the only part moves focus to Add part", async () => {
    await open(CH.thread, { parts: parts("one") });
    await click(allById("part-delete")[0] as HTMLElement);
    await settle();
    expect(document.activeElement).toBe(byId("part-add"));
  });
});

describe("the counters of a thread and of the first comment", () => {
  it("each part and the first comment are described by their own counter", async () => {
    await open(CH.thread, { parts: parts("one", "two") });
    const described = (element: Element | null) =>
      (element?.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.getAttribute("data-testid"));
    expect(allById("part-text").map(described)).toEqual([["part-counter-0"], ["part-counter-1"]]);
    expect(described(byId("first-comment"))).toEqual(["comment-counter"]);
  });
});

describe("the ends and the limit of a thread", () => {
  it("the first part cannot move up and the last cannot move down", async () => {
    await open(CH.thread, { parts: parts("one", "two") });
    expect(allById("part-up")[0]?.getAttribute("aria-disabled")).toBe("true");
    expect(allById("part-down")[1]?.getAttribute("aria-disabled")).toBe("true");
  });

  it("stops at 25 parts and says why", async () => {
    await open(CH.thread, { parts: parts(...Array.from({ length: 25 }, (_, at) => `part ${at}`)) });
    const add = byId("part-add") as HTMLElement;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")?.textContent).toContain("25");
  });

  it("a part over the limit is a check with a link to that part", async () => {
    await open(CH.thread, { parts: parts("fine", "y".repeat(300)) });
    expect(byId("check-issue")?.textContent).toContain("20 over");
    await click(byId("check-go") as HTMLElement);
    await settle();
    expect(document.activeElement).toBe(allById("part-text")[1]);
  });
});

describe("saving parts and the first comment", () => {
  it("sends the thread parts in order and the first comment last", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stub = await open(CH.thread, { parts: parts("one", "two") });
    typeInto(byId("first-comment") as HTMLTextAreaElement, "Link in the comments");
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const [saved] = callsOf(stub, "PATCH", `/posts/${POST}`);
    const body = saved?.body as { draft: { variants: { parts: unknown[] }[] } };
    expect(body.draft.variants[0]?.parts).toEqual([
      { kind: "thread_reply", text: "one" },
      { kind: "thread_reply", text: "two" },
      { kind: "first_comment", text: "Link in the comments" },
    ]);
  });
});
