import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_CHANNEL,
  CONNECT_WS,
  callsTo,
  channelRow,
  click,
  closeApp,
  confirmPassword,
  json,
  openApp,
  refusal,
  settle,
  uuidWorkspaces,
} from "../../../test/support/app";
import { type ChannelApi, providersWith, stubChannelApi } from "../../../test/support/channel-api";
import { setZone } from "../../account/prefs";

afterEach(closeApp);

const PATH = `/w/${CONNECT_WS}/channels/${CONNECT_CHANNEL}`;
const POST = "0190a000-0000-7000-8000-0000000007a1";
const OTHER_POST = "0190a000-0000-7000-8000-0000000007a2";
const provider = { id: "fixture_oauth", display_name: "Fixture Network" };
const CONNECTED = ["check", "disable", "rename", "disconnect"];

const channel = (change: Record<string, unknown> = {}) =>
  json({ data: channelRow({ actions: CONNECTED, ...change }) });
const scheduled = (postId: string, dueAt: string | null) => ({
  variantId: `variant-${postId}`,
  postId,
  dueAt,
});
const impact = (change: Record<string, unknown> = {}) =>
  json({
    data: {
      scheduled: [scheduled(POST, "2026-12-01T09:00:00.000Z"), scheduled(OTHER_POST, null)],
      blocking: [],
      canDisconnect: true,
      truncated: false,
      revokeSupported: true,
      ...change,
    },
  });
const busyItem = (n: number, state = "dispatching", post = POST) => ({
  id: `op-${n}`,
  state,
  postId: post,
  channelName: "Acme Page",
});
const disconnected = (revoke: string, state = "disconnected") =>
  json({
    data: {
      id: CONNECT_CHANNEL,
      connection_state: state,
      disconnected_at: "2026-11-28T10:00:00.000Z",
      reconnect_deadline: "2026-12-28T10:00:00.000Z",
      revoke,
    },
  });
const busyRefusal = (count: number, truncated = false) =>
  json(
    {
      error: {
        code: "conflict",
        requestId: "req-42",
        details: {
          reason: "channel_busy",
          blocking: Array.from({ length: count }, (_, n) => ({
            kind: "operation",
            id: `op-${n}`,
            post_id: n === 0 ? POST : OTHER_POST,
            channel_name: "Acme Page",
            state: "dispatching",
          })),
          ...(truncated ? { truncated: true } : {}),
        },
      },
    },
    409,
  );

async function open(api: ChannelApi = {}, locale: "en" | "ar" = "en") {
  const stub = stubChannelApi({
    workspaces: uuidWorkspaces(),
    providers: providersWith(provider),
    channel: () => channel(),
    impact: () => impact(),
    ...api,
  });
  const opened = await openApp(PATH, locale);
  await settle();
  const trigger = byId(document, "detail-disconnect");
  if (trigger) click(trigger);
  await settle();
  return { stub, ...opened };
}
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialogText = () => dialog()?.textContent ?? "";
const confirm = () => click(byId(dialog() as HTMLElement, "disconnect-confirm") as HTMLElement);
const disconnects = (stub: ReturnType<typeof stubChannelApi>) => callsTo(stub, "POST", "/disconnect");

// The password check is asked by the server once, and the same call is then repeated.
function afterPassword(answer: () => Response): Pick<ChannelApi, "disconnect" | "verifyPassword"> {
  let verified = false;
  return {
    disconnect: () => (verified ? answer() : refusal("step_up_required", 403)),
    verifyPassword: () => {
      verified = true;
      return json({ status: true });
    },
  };
}

describe("the disconnect button", () => {
  it.each<[string[], boolean]>([
    [CONNECTED, true],
    [["check", "disable", "rename"], false],
    [[], false],
  ])("with actions %j it is shown: %s", async (actions, shown) => {
    await open({ channel: () => channel({ actions }) });
    expect(byId(document, "detail-disconnect") !== null).toBe(shown);
  });
});

describe("the impact first", () => {
  it("reads the impact before anything is sent, and lists the posts, the 30 days and the platform request", async () => {
    setZone("UTC");
    const { stub } = await open();
    expect(dialog()?.getAttribute("role")).toBe("alertdialog");
    expect(callsTo(stub, "GET", "/disconnect-impact")).toHaveLength(1);
    expect(disconnects(stub)).toHaveLength(0);
    const text = dialogText();
    expect(text).toContain("2 posts are scheduled for this channel");
    expect(text).toContain(
      "You can reconnect for 30 days. Posts waiting for this channel are held, not deleted; after 30 days they become drafts. Your data is kept.",
    );
    expect(text).toContain("We will also ask Fixture Network to end this access.");
    const links = [...(dialog()?.querySelectorAll<HTMLAnchorElement>("li a") ?? [])];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/w/${CONNECT_WS}/posts/${POST}`,
      `/w/${CONNECT_WS}/posts/${OTHER_POST}`,
    ]);
    expect(links[0]?.querySelector("time")?.getAttribute("datetime")).toBe("2026-12-01T09:00:00.000Z");
  });
});

describe("what the impact says about the platform and the length of its lists", () => {
  it("says before it starts that a platform that cannot end the access leaves that to the person", async () => {
    await open({ impact: () => impact({ revokeSupported: false }) });
    expect(dialogText()).toContain(
      "Fixture Network gives Shoutory no way to end this access. After you disconnect, remove Shoutory's access in your account settings on Fixture Network.",
    );
    expect(dialogText()).not.toContain("We will also ask");
  });

  it("says when the list shows only the first of more", async () => {
    await open({ impact: () => impact({ truncated: true }) });
    expect(byId(dialog() as HTMLElement, "disconnect-truncated")?.textContent).toContain(
      "Only the first 200 are listed",
    );
  });
});

describe("the posts the impact lists", () => {
  it("says plainly when no post is scheduled", async () => {
    await open({ impact: () => impact({ scheduled: [] }) });
    expect(dialogText()).toContain("No posts are scheduled for this channel.");
  });

  it("shows the first five posts and the rest on request", async () => {
    const many = Array.from({ length: 7 }, (_, n) => scheduled(`post-${n}`, "2026-12-01T09:00:00.000Z"));
    await open({ impact: () => impact({ scheduled: many }) });
    expect(dialog()?.querySelectorAll("li")).toHaveLength(5);
    click(byId(dialog() as HTMLElement, "disconnect-show-all") as HTMLElement);
    expect(dialog()?.querySelectorAll("li")).toHaveLength(7);
  });

  it("changes nothing on Cancel and returns focus to the button", async () => {
    const { stub } = await open();
    const cancel = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (one) => one.textContent === "Cancel",
    );
    click(cancel as HTMLElement);
    await settle();
    expect(dialog()).toBeNull();
    expect(disconnects(stub)).toHaveLength(0);
    expect(document.activeElement).toBe(byId(document, "detail-disconnect"));
  });
});

describe("an impact that cannot be confirmed", () => {
  it("offers no confirm when the impact cannot be read, and reads again on Try again", async () => {
    let failing = true;
    await open({ impact: () => (failing ? refusal("internal_error", 500) : impact()) });
    expect(byId(dialog() as HTMLElement, "disconnect-confirm")).toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
    failing = false;
    click(byId(dialog() as HTMLElement, "disconnect-retry") as HTMLElement);
    await settle();
    expect(byId(dialog() as HTMLElement, "disconnect-confirm")).not.toBeNull();
  });

  it("waits while posts are being sent: says how many, links to the posts, and offers no confirm", async () => {
    await open({
      impact: () =>
        impact({
          blocking: [busyItem(1, "dispatching"), busyItem(2, "needs_human", OTHER_POST)],
          canDisconnect: false,
        }),
    });
    expect(dialogText()).toContain("Disconnect waits while 2 posts are being sent");
    expect(byId(dialog() as HTMLElement, "disconnect-confirm")).toBeNull();
    const open_ = [...(dialog()?.querySelectorAll("a") ?? [])].find(
      (one) => one.textContent === "Open posts",
    );
    expect(open_?.getAttribute("href")).toBe(`/w/${CONNECT_WS}/posts`);
  });

  it("links each post that is being sent, naming its channel and what it is doing", async () => {
    await open({
      impact: () =>
        impact({
          blocking: [busyItem(1, "dispatching"), busyItem(2, "needs_human", OTHER_POST)],
          canDisconnect: false,
        }),
    });
    const items = [...(byId(dialog() as HTMLElement, "disconnect-blocking")?.querySelectorAll("li") ?? [])];
    expect(items.map((one) => one.querySelector("a")?.getAttribute("href"))).toEqual([
      `/w/${CONNECT_WS}/posts/${POST}`,
      `/w/${CONNECT_WS}/posts/${OTHER_POST}`,
    ]);
    expect(items[0]?.textContent).toContain("Acme Page");
    expect(items[0]?.textContent).toContain("Sending");
    expect(items[1]?.textContent).toContain("Needs your check");
  });
});

describe("confirming", () => {
  it("asks for the password, repeats the call with the same key, and says Disconnected only after the answer", async () => {
    const pending: { release: (response: Response) => void } = { release: () => undefined };
    const keys: (string | undefined)[] = [];
    let verified = false;
    const { stub } = await open({
      disconnect: (headers) => {
        keys.push(headers["Idempotency-Key"]);
        if (!verified) return refusal("step_up_required", 403);
        return new Promise<Response>((resolve) => {
          pending.release = resolve;
        });
      },
      verifyPassword: () => {
        verified = true;
        return json({ status: true });
      },
    });
    confirm();
    await settle();
    await confirmPassword();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(byId(dialog() as HTMLElement, "disconnect-confirm")?.getAttribute("aria-busy")).toBe("true");
    confirm();
    expect(disconnects(stub)).toHaveLength(2);
    expect(byId(dialog() as HTMLElement, "disconnect-done")).toBeNull();
    await act(async () => pending.release(disconnected("done")));
    expect(byId(dialog() as HTMLElement, "disconnect-done")?.textContent).toBe("Disconnected");
  });

  it("does not say Disconnected when the answer does not confirm the state", async () => {
    await open(afterPassword(() => disconnected("done", "connected")));
    confirm();
    await settle();
    await confirmPassword();
    expect(byId(dialog() as HTMLElement, "disconnect-done")).toBeNull();
    expect(dialogText()).toContain("We could not confirm that the channel was disconnected");
  });
});

describe("what the answer says", () => {
  it("says nothing was changed when the password check is cancelled", async () => {
    await open({ disconnect: () => refusal("step_up_required", 403) });
    confirm();
    await settle();
    click(
      [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
        (one) => one.textContent === "Cancel",
      ) as HTMLElement,
    );
    await settle();
    expect(byId(dialog() as HTMLElement, "disconnect-done")).toBeNull();
    expect(dialogText()).toContain("Disconnecting needs your password again. Nothing was changed.");
  });

  it.each<[string, string, RegExp | null]>([
    ["done", "removed", null],
    ["failed", "did not confirm", /Remove Shoutory's access in your account settings on Fixture Network/],
    [
      "unsupported",
      "gives Shoutory no way",
      /Remove Shoutory's access in your account settings on Fixture Network/,
    ],
  ])("tells the platform result %s", async (revoke, words, instruction) => {
    await open(afterPassword(() => disconnected(revoke)));
    confirm();
    await settle();
    await confirmPassword();
    const line = byId(dialog() as HTMLElement, "disconnect-revoke");
    expect(line?.dataset.revoke).toBe(revoke);
    expect(line?.textContent).toContain(words);
    if (instruction) expect(line?.textContent).toMatch(instruction);
    else expect(line?.textContent).not.toMatch(/Remove Shoutory/);
    expect(dialogText()).toContain("Reconnect by");
  });
});

describe("a refusal and a finished disconnect", () => {
  it("shows the waiting count when the server refuses because posts are being sent", async () => {
    await open({ disconnect: () => busyRefusal(3) });
    confirm();
    await settle();
    expect(byId(dialog() as HTMLElement, "disconnect-done")).toBeNull();
    expect(dialogText()).toContain("Disconnect waits while 3 posts are being sent");
    expect(byId(dialog() as HTMLElement, "disconnect-confirm")).toBeNull();
    expect([...(dialog()?.querySelectorAll("a") ?? [])].map((one) => one.getAttribute("href"))).toContain(
      `/w/${CONNECT_WS}/posts`,
    );
  });

  it("links each post of the refusal to its page and says when the list is cut", async () => {
    await open({ disconnect: () => busyRefusal(2, true) });
    confirm();
    await settle();
    const items = [...(byId(dialog() as HTMLElement, "disconnect-blocking")?.querySelectorAll("li") ?? [])];
    expect(items.map((one) => one.querySelector("a")?.getAttribute("href"))).toEqual([
      `/w/${CONNECT_WS}/posts/${POST}`,
      `/w/${CONNECT_WS}/posts/${OTHER_POST}`,
    ]);
    expect(items[0]?.textContent).toContain("Acme Page");
    expect(byId(dialog() as HTMLElement, "disconnect-truncated")).not.toBeNull();
  });

  it("reads the channel again when the finished dialog is closed", async () => {
    let state = "connected";
    const { stub } = await open({
      ...afterPassword(() => {
        state = "disconnected";
        return disconnected("done");
      }),
      channel: () =>
        state === "connected"
          ? channel()
          : channel({ connection_state: "disconnected", actions: ["reconnect"] }),
    });
    confirm();
    await settle();
    await confirmPassword();
    const close = byId(dialog() as HTMLElement, "disconnect-close") as HTMLElement;
    click(close);
    await settle();
    expect(dialog()).toBeNull();
    expect(callsTo(stub, "GET", `/channels/${CONNECT_CHANNEL}`).length).toBeGreaterThan(1);
    expect(byId(document, "detail-state")?.textContent).toBe("Disconnected");
    expect(byId(document, "detail-disconnect")).toBeNull();
  });
});

describe("in Arabic", () => {
  it("shows the impact dialog in Arabic words", async () => {
    await open({}, "ar");
    const text = dialogText();
    expect(text).toContain("30 يومًا");
    expect(text).not.toContain("You can reconnect");
    expect(dialog()?.querySelector('[data-testid="disconnect-confirm"]')?.textContent).not.toBe("Disconnect");
  });
});
