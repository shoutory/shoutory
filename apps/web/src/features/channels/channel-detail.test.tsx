import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_CHANNEL,
  CONNECT_WS,
  callsTo,
  channelRow,
  click,
  closeApp,
  json,
  openApp,
  refusal,
  settle,
  type,
  uuidWorkspaces,
} from "../../../test/support/app";
import { type ChannelApi, providersWith, stubChannelApi } from "../../../test/support/channel-api";
import { setZone } from "../../account/prefs";

afterEach(closeApp);

const PATH = `/w/${CONNECT_WS}/channels/${CONNECT_CHANNEL}`;
const FULL = ["check", "disable", "rename"];
const provider = { id: "fixture_oauth", display_name: "Fixture Network", capabilities: ["text", "video"] };

const answer = (change: Record<string, unknown> = {}) =>
  json({ data: channelRow({ actions: FULL, ...change }) });

async function visit(api: ChannelApi = {}, path = PATH) {
  const stub = stubChannelApi({
    workspaces: uuidWorkspaces(),
    providers: providersWith(provider),
    channel: () => answer(),
    ...api,
  });
  const opened = await openApp(path);
  await settle();
  return { stub, ...opened };
}
const byId = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (host: ParentNode, id: string) => byId(host, id)?.textContent;
function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

describe("the channel page", () => {
  it("shows the name, nickname, handle, platform, state, access end and what the channel can do", async () => {
    setZone("UTC");
    const { host } = await visit({
      channel: () =>
        answer({
          nickname: "Main page",
          display_name: "Acme Page",
          token_expires_at: "2026-12-20T09:30:00.000Z",
        }),
    });
    expect(host.querySelector("h1")?.textContent).toContain("Acme Page");
    expect(textOf(host, "detail-nickname")).toBe("Main page");
    expect(textOf(host, "detail-handle")).toBe("@acme_page");
    expect(textOf(host, "detail-provider")).toBe("Fixture Network");
    expect(textOf(host, "detail-state")).toBe("Connected");
    expect(textOf(host, "card-expiry")).toMatch(/^Access ends /);
    expect(
      [...host.querySelectorAll('[data-testid="card-capability"]')].map((one) => one.textContent),
    ).toEqual(["Text", "Video"]);
  });

  it("tells when a channel was disconnected and until when it can be reconnected", async () => {
    setZone("UTC");
    const { host } = await visit({
      channel: () =>
        answer({
          connection_state: "disconnected",
          disconnected_at: "2026-11-20T08:00:00.000Z",
          reconnect_deadline: "2026-12-20T08:00:00.000Z",
          actions: ["reconnect", "rename"],
        }),
    });
    expect(textOf(host, "detail-state")).toBe("Disconnected");
    expect(textOf(host, "detail-disconnected")).toMatch(/^Disconnected on /);
    expect(textOf(host, "card-deadline")).toMatch(/^Reconnect by .*; after that these posts become drafts$/);
  });
});

describe("the channel page controls and failures", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a channel the person may not manage", { actions: [] }],
    ["an unknown state", { connection_state: "from_the_future", actions: [] }],
  ])("%s shows no control", async (_name, change) => {
    const { host } = await visit({ channel: () => answer(change) });
    expect(host.querySelectorAll("main button")).toHaveLength(0);
    expect(byId(host, "detail-rename")).toBeNull();
  });

  it.each<[string[], string[]]>([
    [["check"], []],
    [["rename"], ["detail-rename"]],
    [["disable"], ["detail-disable"]],
    [["enable"], ["detail-enable"]],
    [["reconnect"], ["card-reconnect"]],
  ])("the controls of actions %j are %j", async (actions, shown) => {
    const { host } = await visit({ channel: () => answer({ actions }) });
    const found = ["detail-rename", "detail-disable", "detail-enable", "card-reconnect"].filter(
      (id) => byId(host, id) !== null,
    );
    expect(found).toEqual(shown);
  });

  it("answers a channel the server does not know with the not-found page", async () => {
    const { host } = await visit({ channel: () => refusal("not_found", 404) });
    expect(byId(host, "not-found")).not.toBeNull();
  });

  it("answers a workspace that is not the person's with the not-found page and reads nothing", async () => {
    const other = "0190a000-0000-7000-8000-0000000000c2";
    const { host, stub } = await visit({}, `/w/${other}/channels/${CONNECT_CHANNEL}`);
    expect(byId(host, "not-found")).not.toBeNull();
    expect(callsTo(stub, "GET", `/channels/${CONNECT_CHANNEL}`)).toHaveLength(0);
  });

  it("says a failed read failed, and reads again on Try again", async () => {
    let failing = true;
    const { host } = await visit({ channel: () => (failing ? refusal("internal_error", 500) : answer()) });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    failing = false;
    click(byId(host, "detail-retry") as HTMLElement);
    await settle();
    expect(textOf(host, "detail-state")).toBe("Connected");
  });
});

describe("rename", () => {
  const field = (host: ParentNode) =>
    host.querySelector<HTMLInputElement>('[data-testid="detail-nickname-input"]');

  it("sends the new nickname once, shows the answer, and ignores a second press while it runs", async () => {
    const pending = deferred();
    let sent: unknown[] = [];
    const { host, stub } = await visit({
      rename: (body) => {
        sent = [...sent, body];
        return pending.answer();
      },
    });
    type(field(host) as HTMLInputElement, "Main page");
    click(byId(host, "detail-rename") as HTMLElement);
    click(byId(host, "detail-rename") as HTMLElement);
    expect(byId(host, "detail-rename")?.getAttribute("aria-busy")).toBe("true");
    expect(callsTo(stub, "PATCH", `/channels/${CONNECT_CHANNEL}`)).toHaveLength(1);
    await act(async () => pending.release(answer({ nickname: "Main page" })));
    expect(sent).toEqual([{ nickname: "Main page" }]);
    expect(textOf(host, "detail-nickname")).toBe("Main page");
  });

  it("clears the nickname when the field is emptied", async () => {
    let sent: unknown;
    const { host } = await visit({
      channel: () => answer({ nickname: "Old" }),
      rename: (body) => {
        sent = body;
        return answer({ nickname: null });
      },
    });
    type(field(host) as HTMLInputElement, "  ");
    click(byId(host, "detail-rename") as HTMLElement);
    await settle();
    expect(sent).toEqual({ nickname: null });
    expect(byId(host, "detail-nickname")).toBeNull();
  });

  it("keeps what was typed and says it failed when the server refuses", async () => {
    const { host } = await visit({ rename: () => refusal("internal_error", 500) });
    type(field(host) as HTMLInputElement, "Main page");
    click(byId(host, "detail-rename") as HTMLElement);
    await settle();
    const error = byId(host, "detail-rename-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(field(host)?.value).toBe("Main page");
    expect(field(host)?.getAttribute("aria-describedby")).toContain(error?.id);
  });
});

describe("turn off and on", () => {
  it("turns the channel off once, and offers Turn on from the answer's own actions", async () => {
    const pending = deferred();
    const moves: string[] = [];
    const { host } = await visit({
      move: (move) => {
        moves.push(move);
        return pending.answer();
      },
    });
    click(byId(host, "detail-disable") as HTMLElement);
    click(byId(host, "detail-disable") as HTMLElement);
    expect(byId(host, "detail-disable")?.getAttribute("aria-busy")).toBe("true");
    await act(async () =>
      pending.release(answer({ connection_state: "disabled", actions: ["enable", "rename"] })),
    );
    expect(moves).toEqual(["disable"]);
    expect(textOf(host, "detail-state")).toBe("Turned off");
    expect(byId(host, "detail-disable")).toBeNull();
    expect(byId(host, "detail-enable")).not.toBeNull();
  });

  it("turns a channel on and shows what the server answers", async () => {
    const moves: string[] = [];
    const { host } = await visit({
      channel: () => answer({ connection_state: "disabled", actions: ["enable"] }),
      move: (move) => {
        moves.push(move);
        return answer();
      },
    });
    click(byId(host, "detail-enable") as HTMLElement);
    await settle();
    expect(moves).toEqual(["enable"]);
    expect(textOf(host, "detail-state")).toBe("Connected");
  });

  it("says nothing changed when the server refuses, and lets the person press again", async () => {
    const { host } = await visit({ move: () => refusal("conflict", 409, { reason: "not_connected" }) });
    click(byId(host, "detail-disable") as HTMLElement);
    await settle();
    expect(textOf(host, "detail-move-error")).toMatch(/Nothing was changed/);
    expect(textOf(host, "detail-state")).toBe("Connected");
    expect(byId(host, "detail-disable")?.getAttribute("aria-busy")).toBeNull();
  });
});
