import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, json, openApp, refusal, settle } from "../../../test/support/app";
import {
  allById,
  byId,
  type Call,
  CH,
  callsOf,
  field,
  POST,
  stubComposerApi,
  typeInto,
  VERSION_1,
  variantRow,
} from "../../../test/support/composer-api";

afterEach(closeApp);

const LIVE = "2026-11-28T08:00:00.000Z";
const NEW_POST = "0190a000-0000-7000-8000-00000000a002";

const live = (channel: string, text: string, actions: string[]) => ({
  variant: variantRow(channel, text),
  target: {
    variant_id: `0190a000-0000-7000-8000-00000000e0${channel.slice(-2)}`,
    channel_id: channel,
    schedule_state: "settled",
    published_at: LIVE,
    due_at: null,
    due_tz: null,
    hold_reason: null,
    actions,
  },
});

interface Setup {
  edit?: (call: Call) => Response;
  both?: boolean;
}

async function open(setup: Setup = {}) {
  const parts = [live(CH.short, "Live words", ["edit", "duplicate"])];
  if (setup.both) parts.push(live(CH.thread, "Other words", ["duplicate"]));
  const stub = stubComposerApi({
    answer: (call) => {
      if (call.method === "GET" && call.path === `posts/${POST}`) {
        return json({
          data: {
            id: POST,
            status: "published",
            current_version_id: VERSION_1,
            variants: parts.map((one) => one.variant),
            targets: parts.map((one) => one.target),
          },
        });
      }
      if (call.method === "POST" && call.path === `posts/${POST}/edit`) {
        return (
          setup.edit?.(call) ?? json({ data: { id: POST, version_id: VERSION_1, operation_ids: ["x"] } })
        );
      }
      if (call.method === "POST" && call.path === "posts")
        return json({ data: { id: NEW_POST, version_id: VERSION_1 } }, 201);
      return undefined;
    },
  });
  const opened = await openApp(`/w/w1/posts/${POST}/edit`);
  await settle();
  return { stub, ...opened };
}

const change = async (text: string) => {
  typeInto(field("composer-base"), text);
  await settle();
};
const save = async () => {
  await click(byId("edit-submit") as HTMLElement);
  await settle();
};

describe("editing a post that is live", () => {
  it("offers an edit instead of scheduling, and never saves a draft behind the person's back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { stub } = await open();
    expect(byId("schedule-submit")).toBeNull();
    expect(byId("publish-now")).toBeNull();
    await change("Better words");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callsOf(stub, "PATCH", `/posts/${POST}`)).toHaveLength(0);
  });

  it("sends the edit against the version it read with a key, then says it went to the queue", async () => {
    const { stub } = await open({ both: true });
    await change("Better words");
    await save();
    const [call] = callsOf(stub, "POST", `/posts/${POST}/edit`);
    expect(call?.headers["If-Match"]).toBe(`"${VERSION_1}"`);
    expect(call?.headers["Idempotency-Key"]).toBeTruthy();
    const body = call?.body as { draft: { variants: { channel_id: string; text: string }[] } };
    expect(body.draft.variants.map((one) => [one.channel_id, one.text])).toEqual([
      [CH.short, "Better words"],
    ]);
    expect(byId("edit-sent")?.textContent).toContain("Sent to the queue");
    expect(document.body.textContent).not.toContain("Published");
  });

  it("is not offered while nothing has changed", async () => {
    await open();
    const button = byId("edit-submit") as HTMLElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
      "change",
    );
  });

  it("is not offered while the text is over the limit", async () => {
    await open();
    await change("z".repeat(40));
    expect(byId("edit-submit")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not show how long the edit window lasts, because the page is not told", async () => {
    await open();
    expect(document.body.textContent).not.toContain("more hours");
  });
});

describe("what the server refuses to edit", () => {
  const lists = (reason: string, actions: string[]) =>
    json({ error: { code: "conflict", message: "x", requestId: "r", details: { reason, actions } } }, 409);

  it.each<[string, () => Response, string, boolean]>([
    ["a post being sent", () => lists("post_in_flight", ["duplicate"]), "being posted right now", true],
    [
      "the end of the edit window",
      () => refusal("conflict", 409, { reason: "edit_window_closed" }),
      "time for editing",
      false,
    ],
    ["a channel with a record", () => lists("variant_has_history", ["duplicate"]), "posting record", true],
    ["an archived post", () => lists("post_archived", ["duplicate"]), "archived", true],
  ])(
    "%s is explained, with the copy offered only when the server lists it",
    async (_name, answer, words, copy) => {
      await open({ edit: answer });
      await change("Better words");
      await save();
      expect(byId("edit-failure")?.textContent).toContain(words);
      expect(byId("edit-failure")?.textContent?.includes("Duplicate to draft")).toBe(copy);
      expect(byId("edit-sent")).toBeNull();
    },
  );

  it("a newer version means reloading, not sending again", async () => {
    await open({ edit: () => refusal("precondition_failed", 412, { current_version_id: VERSION_1 }) });
    await change("Better words");
    await save();
    expect(byId("edit-stale")?.textContent).toContain("changed");
  });

  it("the copy is made through the draft route and opened", async () => {
    const { stub, router } = await open({
      edit: () =>
        json(
          {
            error: {
              code: "conflict",
              message: "x",
              requestId: "r",
              details: { reason: "post_archived", actions: ["duplicate"] },
            },
          },
          409,
        ),
    });
    await change("Better words");
    await save();
    await click(allById("refusal-duplicate")[0] as HTMLElement);
    await settle();
    const made = callsOf(stub, "POST", "/posts").at(-1);
    const body = made?.body as { draft: { variants: { text: string }[] } };
    expect(body.draft.variants[0]?.text).toBe("Better words");
    expect(router.state.location.pathname).toBe(`/w/w1/posts/${NEW_POST}/edit`);
  });
});
