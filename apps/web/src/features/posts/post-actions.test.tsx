import { afterEach, describe, expect, it } from "vitest";
import { click, closeApp, json, openApp, refusal, settle, uuidWorkspaces } from "../../../test/support/app";
import {
  bodyOf,
  detailAnswer,
  detailTarget,
  OPERATION,
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

async function visit(api: PostApi = {}) {
  const stub = stubPostApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(PATH);
  await settle();
  return { stub, ...opened };
}
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pending = {
  published_at: null,
  schedule_state: "scheduled",
  due_at: "2026-12-01T09:00:00.000Z",
  due_tz: "UTC",
  operation: operation({ state: "pending", effect: "none" }),
};
const target = (actions: string[], change: Record<string, unknown> = {}) =>
  detailTarget({ ...pending, actions, ...change });
const showing = (...targets: unknown[]): PostApi => ({ postDetail: () => detailAnswer(targets) });
const callsTo = (stub: ReturnType<typeof stubPostApi>, method: string, part: string) =>
  stub.mock.calls.filter(([url, init]) => url.includes(part) && (init?.method ?? "GET") === method);
const keyOf = (call: [path: string, init?: RequestInit | undefined] | undefined) =>
  (call?.[1]?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

describe("the buttons come only from the actions the server lists", () => {
  it.each<[string, string[], string[]]>([
    ["cancel", ["cancel"], ["action-cancel"]],
    ["unschedule", ["unschedule"], ["action-unschedule"]],
    ["edit", ["edit"], ["action-edit"]],
    ["schedule and publish now", ["schedule", "publish_now"], ["action-schedule", "action-publish_now"]],
    ["nothing", [], []],
  ])("a target that lists %s shows exactly those controls", async (_name, actions, shown) => {
    const { host } = await visit(showing(target(actions)));
    const all = [
      "action-cancel",
      "action-unschedule",
      "action-edit",
      "action-schedule",
      "action-publish_now",
    ];
    expect(all.filter((id) => byId(host, id) !== null)).toEqual(shown);
  });

  it("a waiting target whose list lacks cancel has no Cancel, whatever its state", async () => {
    const { host } = await visit(showing(target(["duplicate"])));
    expect(byId(host, "action-cancel")).toBeNull();
    expect(host.textContent).not.toContain("Cancel");
  });

  it("shows Cancel on the row with when it ends, without any press", async () => {
    const { host, stub } = await visit(showing(target(["cancel"])));
    expect(byId(host, "action-cancel")?.textContent).toBe("Cancel");
    expect(host.textContent).toContain("until sending starts");
    expect(callsTo(stub, "POST", "/cancel")).toHaveLength(0);
  });

  it("links Edit, Schedule and Publish now to the composer of this post", async () => {
    const { host } = await visit(showing(target(["edit", "schedule", "publish_now"])));
    const links = ["action-edit", "action-schedule", "action-publish_now"].map((id) =>
      byId(host, id)?.getAttribute("href"),
    );
    expect(links).toEqual(Array(3).fill(`${PATH}/edit`));
  });

  it("offers the copy only when the server lists duplicate, once for the whole post", async () => {
    const both = [target(["duplicate"]), target(["duplicate"], { variant_id: variantId(2) })];
    const { host } = await visit(showing(...both));
    expect(host.querySelectorAll('[data-testid="action-duplicate"]')).toHaveLength(1);
    closeApp();
    const none = await visit(showing(target([])));
    expect(byId(none.host, "action-duplicate")).toBeNull();
  });
});

describe("Cancel", () => {
  it("cancels the operation with a fresh key and reads the post again, which drops the button", async () => {
    let cancelled = false;
    const { host, stub } = await visit({
      postDetail: () =>
        detailAnswer([
          cancelled
            ? target([], { operation: operation({ state: "cancelled", effect: "none" }) })
            : target(["cancel"]),
        ]),
      cancel: () => {
        cancelled = true;
        return json({ data: { operation_id: OPERATION, state: "cancelled" } });
      },
    });
    click(byId(host, "action-cancel") as HTMLElement);
    await settle();
    const [call] = callsTo(stub, "POST", `/operations/${OPERATION}/cancel`);
    expect(keyOf(call)).toMatch(UUID_V7);
    expect(bodyOf(stub, "POST", "/cancel")).toEqual({});
    expect(byId(host, "action-cancel")).toBeNull();
    expect(byId(host, "target-word")?.textContent).toBe("Cancelled");
  });

  it("is busy and ignores a second press while the call runs", async () => {
    const wait = deferred();
    const { host, stub } = await visit({ ...showing(target(["cancel"])), cancel: wait.answer });
    const button = byId(host, "action-cancel") as HTMLElement;
    click(button);
    click(button);
    await settle();
    expect(callsTo(stub, "POST", "/cancel")).toHaveLength(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    wait.release(json({ data: { operation_id: OPERATION, state: "cancelled" } }));
    await settle();
    expect(button.getAttribute("aria-busy")).toBeNull();
  });
});

describe("a refused Cancel", () => {
  it("sends a new key on each press after a refusal", async () => {
    const { host, stub } = await visit({
      ...showing(target(["cancel"])),
      cancel: () => refusal("conflict", 409),
    });
    click(byId(host, "action-cancel") as HTMLElement);
    await settle();
    click(byId(host, "action-cancel") as HTMLElement);
    await settle();
    const [first, second] = callsTo(stub, "POST", "/cancel");
    expect(keyOf(first)).toMatch(UUID_V7);
    expect(keyOf(second)).toMatch(UUID_V7);
    expect(keyOf(first)).not.toBe(keyOf(second));
  });

  it.each<[string, () => Response, RegExp]>([
    ["a state that moved on", () => refusal("conflict", 409), /changed while you were looking/],
    ["a refused role", () => refusal("forbidden", 403), /Only the author of the post, an admin or the owner/],
    ["a failure", () => refusal("internal_error", 500), /We could not do that/],
  ])("says what happened for %s and keeps the button", async (_name, answer, words) => {
    const { host } = await visit({ ...showing(target(["cancel"])), cancel: answer });
    click(byId(host, "action-cancel") as HTMLElement);
    await settle();
    expect(byId(host, "post-refusal")?.textContent).toMatch(words);
    expect(byId(host, "post-refusal")?.textContent).toContain("req-42");
    expect(host.textContent).not.toContain("words the user must never see");
    expect(byId(host, "action-cancel")).not.toBeNull();
  });
});

describe("Unschedule and the copy", () => {
  it("unschedules this target with a fresh key and reads the post again", async () => {
    const { host, stub } = await visit({
      ...showing(target(["unschedule"])),
      unschedule: () => json({ data: { post_id: postId(1), variant_ids: [variantId(1)] } }),
    });
    click(byId(host, "action-unschedule") as HTMLElement);
    await settle();
    expect(bodyOf(stub, "POST", "/unschedule")).toEqual({ variant_ids: [variantId(1)] });
    expect(keyOf(callsTo(stub, "POST", "/unschedule")[0])).toMatch(UUID_V7);
    expect(callsTo(stub, "GET", postId(1)).length).toBeGreaterThan(1);
  });

  it("makes the copy through the create route from the current version's draft and opens its composer", async () => {
    const draft = {
      variants: [
        {
          channel_id: "0190a000-0000-7000-8000-0000000000d1",
          locale: null,
          post_type: "text",
          text: "Hello from the post",
          parts: [],
          settings: {},
          media: [],
        },
      ],
    };
    const { host, stub, router } = await visit({
      ...showing(target(["duplicate"])),
      postVersion: () => json({ data: { id: VERSION, version_no: 1, kind: "scheduled", draft } }),
      postCreate: () => json({ data: { id: postId(9), version_id: VERSION } }, 201),
    });
    click(byId(host, "action-duplicate") as HTMLElement);
    await settle();
    expect(callsTo(stub, "GET", `/versions/${VERSION}`)).toHaveLength(1);
    expect(bodyOf(stub, "POST", `/posts`)).toEqual({ draft });
    expect(keyOf(callsTo(stub, "POST", "/posts")[0])).toMatch(UUID_V7);
    expect(router.state.location.pathname).toBe(`/w/${POST_WS}/posts/${postId(9)}/edit`);
  });

  it("names a refused copy and stays on the post", async () => {
    const { host, router } = await visit({
      ...showing(target(["duplicate"])),
      postVersion: () => refusal("not_found", 404),
    });
    click(byId(host, "action-duplicate") as HTMLElement);
    await settle();
    expect(byId(host, "post-refusal")).not.toBeNull();
    expect(router.state.location.pathname).toBe(PATH);
  });
});
