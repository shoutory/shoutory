import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, closeApp, json, openApp, refusal, settle, uuidWorkspaces } from "../../../test/support/app";
import {
  CHANNEL_ONE,
  detail,
  detailTarget,
  operation,
  POST_WS,
  type PostApi,
  postId,
  stubPostApi,
  VERSION,
  variantId,
} from "../../../test/support/post-api";

afterEach(closeApp);

const PATH = `/w/${POST_WS}/posts/${postId(1)}`;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const live = (actions: string[]) => detailTarget({ actions });
const removing = detailTarget({
  presence: "removal_pending",
  actions: [],
  operation: operation({ kind: "delete", state: "dispatching", effect: "possible" }),
});
const removed = detailTarget({
  presence: "removed_at_provider",
  actions: [],
  operation: operation({ kind: "delete", state: "published", effect: "confirmed" }),
});
const thread = (replies: number) => ({
  variants: [
    {
      id: variantId(1),
      channel_id: CHANNEL_ONE,
      locale: "en",
      post_type: "text",
      text: "First part",
      parts: Array.from({ length: replies }, () => ({ kind: "thread_reply", text: "More" })),
      settings: {},
      media: [],
    },
  ],
});
const answer = (target: unknown, change: Record<string, unknown> = {}) => {
  const { variants, ...rest } = detail([target], change);
  return json({ data: { ...rest, variants: change.variants ?? variants } });
};

async function visit(api: PostApi, locale: "en" | "ar" = "en") {
  const stub = stubPostApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH, locale);
  await settle();
  return { stub, ...opened };
}
const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const alertdialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
const open = async (api: PostApi, locale: "en" | "ar" = "en") => {
  const opened = await visit(api, locale);
  click(byId("action-delete") as HTMLElement);
  await settle();
  return opened;
};
const deletes = (stub: ReturnType<typeof stubPostApi>) =>
  stub.mock.calls.filter(([, init]) => init?.method === "DELETE");
const headerOf = (call: [path: string, init?: RequestInit | undefined] | undefined, name: string) =>
  (call?.[1]?.headers as Record<string, string> | undefined)?.[name];

describe("the Delete button", () => {
  it("is on a target only when the server lists delete, and names the channel", async () => {
    const shown = await visit({ postDetail: () => answer(live(["delete"])) });
    expect(byId("action-delete")?.textContent).toContain("Delete from Acme Page");
    closeApp();
    await visit({ postDetail: () => answer(live(["duplicate"])) });
    expect(byId("action-delete")).toBeNull();
    expect(shown.host).not.toBeNull();
  });

  it.each<[string, number, RegExp]>([
    ["one part", 0, /^Removes it from Fixture Network\. This cannot be undone on the platform\.$/],
    ["a thread of three", 2, /Removes it from Fixture Network\. 3 thread parts\. This cannot be undone/],
  ])("asks first and says what leaves the platform for %s", async (_name, replies, words) => {
    const { stub } = await open({ postDetail: () => answer(live(["delete"]), thread(replies)) });
    expect(alertdialog()).not.toBeNull();
    expect(byId("delete-impact")?.textContent).toMatch(words);
    expect(deletes(stub)).toHaveLength(0);
  });

  it("says it in Arabic with the platform's name", async () => {
    await open({ postDetail: () => answer(live(["delete"])) }, "ar");
    expect(byId("delete-impact")?.textContent).toContain("Fixture Network");
    expect(byId("delete-impact")?.textContent).toContain("لا يمكن التراجع عنه");
  });
});

describe("confirming a delete", () => {
  it("sends the post's version, the channel and a fresh key, then shows the removal through to removed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stage = 0;
    const { stub } = await open({
      postDetail: () => answer([live(["delete"]), removing, removed][stage] ?? removed),
      postDelete: () => {
        stage = 1;
        return json({ data: { post_id: postId(1), operation_ids: ["op"] } });
      },
    });
    click(byId("delete-confirm") as HTMLElement);
    await settle();
    const [call] = deletes(stub);
    expect(call?.[0]).toContain(`/posts/${postId(1)}`);
    expect(headerOf(call, "If-Match")).toBe(`"${VERSION}"`);
    expect(headerOf(call, "Idempotency-Key")).toMatch(UUID_V7);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ variant_ids: [variantId(1)] });
    expect(alertdialog()).toBeNull();
    expect(document.body.querySelector('[data-testid="target-word"]')?.textContent).toBe(
      "Removing from Fixture Network",
    );
    stage = 2;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(document.body.querySelector('[data-testid="target-word"]')?.textContent).toBe(
      "Removed from Fixture Network",
    );
    const reads = stub.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(stub.mock.calls.length).toBe(reads);
  });
});

describe("pressing Delete twice and leaving", () => {
  it("is busy and ignores a second press while the call runs", async () => {
    let calls = 0;
    const { stub } = await open({
      postDetail: () => answer(live(["delete"])),
      postDelete: () => {
        calls += 1;
        return new Promise<Response>(() => undefined);
      },
    });
    const button = byId("delete-confirm") as HTMLElement;
    click(button);
    click(button);
    await settle();
    expect(calls).toBe(1);
    expect(deletes(stub)).toHaveLength(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("closes with Cancel without any call", async () => {
    const { stub } = await open({ postDetail: () => answer(live(["delete"])) });
    click(byId("delete-cancel") as HTMLElement);
    await settle();
    expect(alertdialog()).toBeNull();
    expect(deletes(stub)).toHaveLength(0);
    expect(byId("action-delete")).not.toBeNull();
  });
});

const refusedWith = (code: string, status: number, reason: string, actions: string[] = []) =>
  json(
    { error: { code, requestId: "req-42", details: { reason, ...(actions.length ? { actions } : {}) } } },
    status,
  );

describe("a refused delete", () => {
  it.each<[string, () => Response, RegExp]>([
    [
      "the window closed",
      () => refusedWith("conflict", 409, "delete_window_closed"),
      /no longer lets us delete it from here/,
    ],
    [
      "a post still being sent",
      () => refusedWith("conflict", 409, "post_in_flight", ["duplicate"]),
      /being posted right now/,
    ],
    ["a post that was never published", () => refusedWith("conflict", 409, "not_published"), /not published/],
    ["a post that changed", () => refusal("precondition_failed", 412), /changed while you were looking/],
    [
      "a role that may not",
      () => refusal("forbidden", 403),
      /Only the author of the post, an admin or the owner/,
    ],
  ])("shows %s as a panel with its request id and changes nothing", async (_name, failure, words) => {
    const { stub } = await open({ postDetail: () => answer(live(["delete"])), postDelete: failure });
    click(byId("delete-confirm") as HTMLElement);
    await settle();
    const panel = byId("delete-refusal");
    expect(panel?.textContent).toMatch(words);
    expect(panel?.textContent).toContain("req-42");
    expect(panel?.textContent).not.toContain("words the user must never see");
    expect(alertdialog()).not.toBeNull();
    expect(deletes(stub)).toHaveLength(1);
  });
});

describe("what a refused delete offers next", () => {
  it("offers the copy to a draft that the server listed with the refusal", async () => {
    await open({
      postDetail: () => answer(live(["delete"])),
      postDelete: () => refusedWith("conflict", 409, "post_in_flight", ["duplicate"]),
    });
    click(byId("delete-confirm") as HTMLElement);
    await settle();
    expect(byId("delete-refusal")?.querySelector('[data-testid="action-duplicate"]')).not.toBeNull();
  });

  it("sends a new key on the next press", async () => {
    const { stub } = await open({
      postDetail: () => answer(live(["delete"])),
      postDelete: () => refusedWith("conflict", 409, "delete_window_closed"),
    });
    click(byId("delete-confirm") as HTMLElement);
    await settle();
    click(byId("delete-confirm") as HTMLElement);
    await settle();
    const [first, second] = deletes(stub);
    expect(headerOf(first, "Idempotency-Key")).not.toBe(headerOf(second, "Idempotency-Key"));
  });
});
