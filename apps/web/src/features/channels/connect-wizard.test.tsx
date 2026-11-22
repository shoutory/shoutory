import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Api,
  CONNECT_WS,
  callsTo,
  channelPage,
  channelRow,
  click,
  closeApp,
  json,
  openApp,
  PROVIDERS,
  pageOf,
  press,
  refusal,
  START_URL,
  settle,
  stubApi,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(() => {
  closeApp();
  vi.restoreAllMocks();
});

// Connecting a channel (H-02) and reconnecting one (H-05): "Add channel" opens a dialog of platforms, a tile starts the
// OAuth flow with one POST and sends the browser to the address the server answers, only when that address is https.
// Elements are selected by test id: `hub-add`, `hub-add-empty`, `card-reconnect`, `card-reconnect-error`
// (`data-reason`), the dialog's `wizard-state` (`data-state`: loading, failed, empty, tiles), `wizard-retry`,
// `wizard-cancel`, `provider-tile`, `tile-start` (`data-provider-id`), `tile-beta` and `start-error` (`data-reason`:
// forbidden, not_found, rate_limited, unavailable, server).

const PATH = `/w/${CONNECT_WS}/channels`;
const OTHER = "0190a000-0000-7000-8000-0000000000c2";
const idOf = (n: number) => `0190a000-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`;
const row = (n: number, change: Record<string, unknown> = {}) =>
  channelRow({ id: idOf(n), display_name: `Channel ${n}`, handle: `@channel_${n}`, ...change });
const provider = (id: string, change: Record<string, unknown> = {}) => ({
  ...PROVIDERS[0],
  id,
  display_name: `Network ${id}`,
  ...change,
});

const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const byId = (host: ParentNode, id: string) => all(host, id)[0] ?? null;
const dialogOf = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const stateOf = () => byId(document.body, "wizard-state")?.dataset.state;
const spyAssign = () => vi.spyOn(window.location, "assign").mockImplementation(() => undefined);

async function visit(api: Api = {}, path = PATH) {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(path);
  await settle();
  return { stub, ...opened };
}
const listWith = (actions: string[], ...rows: unknown[]): Api => ({
  channelList: () => channelPage(rows, null, actions),
});
const starts = (stub: ReturnType<typeof stubApi>) => callsTo(stub, "POST", "/start");
const providerReads = (stub: ReturnType<typeof stubApi>) => callsTo(stub, "GET", "/providers");
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}
async function openDialog(host: HTMLElement) {
  click(byId(host, "hub-add") as HTMLElement);
  await settle();
}
const startTile = () => byId(document.body, "tile-start") as HTMLElement;

describe("Add channel and Reconnect come from the server's actions, never from a guess", () => {
  it.each<[string, Api, boolean, boolean]>([
    ["connect and reconnect", listWith(["connect"], row(1, { actions: ["reconnect"] })), true, true],
    ["neither", listWith([], row(1, { actions: ["check"] })), false, false],
    ["connect only", listWith(["connect"], row(1, { actions: [] })), true, false],
    ["reconnect only", listWith([], row(1, { actions: ["reconnect"] })), false, true],
  ])("%s", async (_name, api, add, reconnect) => {
    const { host } = await visit(api);
    expect(byId(host, "hub-add") !== null).toBe(add);
    expect(byId(host, "card-reconnect") !== null).toBe(reconnect);
  });

  it.each<[string, string[], boolean]>([
    [
      "an empty list that holds connect offers Add channel twice: in the heading and in the empty state",
      ["connect"],
      true,
    ],
    ["an empty list without connect offers it nowhere", [], false],
  ])("%s", async (_name, actions, offered) => {
    const { host } = await visit(listWith(actions));
    expect(byId(host, "hub-add") !== null).toBe(offered);
    expect(byId(host, "hub-add-empty") !== null).toBe(offered);
  });
});

describe("starting a connection", () => {
  it("posts {} to the dialog workspace's provider path with the client header, follows the answered address once, and keeps it nowhere", async () => {
    const assign = spyAssign();
    const { host, stub } = await visit(listWith(["connect"]));
    await openDialog(host);
    click(startTile());
    await settle();
    const [[url, init]] = starts(stub) as [[string, RequestInit]];
    expect(url).toBe(`/api/v1/workspaces/${CONNECT_WS}/connect/fixture_oauth/start`);
    expect(init.body).toBe("{}");
    expect((init.headers as Record<string, string>)["X-Shoutory-Client"]).toBe("web");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(new URL(START_URL).href);
    expect(document.body.textContent).not.toContain("flow-state-1");
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("flow-state-1");
  });

  it("a second press while one is pending sends nothing, the tile says it is busy, and the page showing again resets it", async () => {
    const assign = spyAssign();
    const pending = deferred();
    // The first start waits; a start after the page showed again gets an answer of its own (a body is read once).
    let calls = 0;
    const { host, stub } = await visit({
      ...listWith(["connect"]),
      providers: () => json({ data: [provider("a_ga"), provider("b_ga")] }),
      connectStart: () => (calls++ === 0 ? pending.answer() : json({ data: { authorize_url: START_URL } })),
    });
    await openDialog(host);
    // Pressing another tile while the first is pending sends nothing and does not move the busy mark to that tile.
    const [first, second] = all(document.body, "tile-start") as [HTMLElement, HTMLElement];
    click(first);
    click(second);
    await settle();
    expect(starts(stub)).toHaveLength(1);
    expect(starts(stub)[0]?.[0]).toBe(`/api/v1/workspaces/${CONNECT_WS}/connect/a_ga/start`);
    expect(first.getAttribute("aria-busy")).toBe("true");
    expect(second.getAttribute("aria-busy")).toBeNull();
    expect(first.textContent).toContain("Network a_ga");
    expect(second.textContent).toContain("Network b_ga");
    expect(startTile().getAttribute("aria-busy")).toBe("true");
    pending.release(json({ data: { authorize_url: START_URL } }));
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    // The browser came back (the back button restores the page): the press is possible again.
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(startTile().getAttribute("aria-busy")).toBeNull();
    click(startTile());
    await settle();
    expect(starts(stub)).toHaveLength(2);
  });
});

describe("what a start answers", () => {
  // Security floor: the browser is sent only to an https address the server answered, and nowhere else.
  it.each<[string, unknown]>([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["http:", "http://provider.example.test/authorize"],
    ["a protocol-relative address", "//provider.example.test/authorize"],
    ["a relative path", "/authorize?state=x"],
    ["an empty string", ""],
    ["a number", 5],
  ])("an answered address that is %s is not followed", async (_name, value) => {
    const assign = spyAssign();
    const { host } = await visit({
      ...listWith(["connect"]),
      connectStart: () => json({ data: { authorize_url: value } }),
    });
    await openDialog(host);
    click(startTile());
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(byId(document.body, "start-error")?.dataset.reason).toBe("server");
  });

  it.each<[string, () => Response | Promise<Response>, string]>([
    ["a 403", () => refusal("forbidden", 403), "forbidden"],
    ["a 404", () => refusal("not_found", 404), "not_found"],
    ["a 429", () => refusal("too_many_requests", 429), "rate_limited"],
    ["a 503", () => refusal("service_unavailable", 503), "unavailable"],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "unavailable"],
    ["a 400", () => refusal("validation_failed", 400), "server"],
    ["a 500", () => refusal("internal_error", 500), "server"],
    ["an answer with no address", () => json({ data: {} }), "server"],
  ])(
    "%s shows its own line, goes nowhere, and lets the person press again",
    async (_name, answer, reason) => {
      const assign = spyAssign();
      const { host } = await visit({ ...listWith(["connect"]), connectStart: answer });
      await openDialog(host);
      click(startTile());
      await settle();
      const said = byId(document.body, "start-error");
      expect(said?.dataset.reason).toBe(reason);
      expect(said?.textContent?.length).toBeGreaterThan(0);
      expect(assign).not.toHaveBeenCalled();
      expect(startTile().getAttribute("aria-busy")).toBeNull();
    },
  );
});

describe("a session that ended", () => {
  it("during the start goes to sign-in and comes back to this page", async () => {
    const assign = spyAssign();
    const { host, router } = await visit({
      ...listWith(["connect"]),
      connectStart: () => refusal("unauthenticated", 401),
    });
    await openDialog(host);
    click(startTile());
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe(`?return-to=${encodeURIComponent(PATH)}`);
  });
});

describe("reconnecting a channel", () => {
  const rows = () => [
    row(1, { actions: ["reconnect"], connection_state: "needs_reconnect" }),
    row(2, { actions: ["reconnect"], connection_state: "disconnected", provider_id: "fixture_other" }),
  ];

  it("posts the pressed card's channel_id to that card's provider and follows the answered address once", async () => {
    const assign = spyAssign();
    const { host, stub } = await visit(listWith(["connect"], ...rows()));
    const second = byId(
      host.querySelector(`[data-channel-id="${idOf(2)}"]`) as HTMLElement,
      "card-reconnect",
    );
    click(second as HTMLElement);
    await settle();
    const [[url, init]] = starts(stub) as [[string, RequestInit]];
    expect(url).toBe(`/api/v1/workspaces/${CONNECT_WS}/connect/fixture_other/start`);
    expect(JSON.parse(String(init.body))).toEqual({ channel_id: idOf(2) });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(new URL(START_URL).href);
  });

  it("a refusal shows its line on that card only and goes nowhere", async () => {
    const assign = spyAssign();
    const { host } = await visit({
      ...listWith(["connect"], ...rows()),
      connectStart: () => refusal("forbidden", 403),
    });
    const first = host.querySelector(`[data-channel-id="${idOf(1)}"]`) as HTMLElement;
    click(byId(first, "card-reconnect") as HTMLElement);
    await settle();
    expect(byId(first, "card-reconnect-error")?.dataset.reason).toBe("forbidden");
    expect(all(host, "card-reconnect-error")).toHaveLength(1);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the platforms of the dialog", () => {
  const platforms = [
    provider("a_ga"),
    provider("b_beta", { lifecycle: "beta" }),
    provider("c_idle", { connectable: false }),
    provider("d_key", { auth_kind: "api_key" }),
  ];

  it("starts only a connectable OAuth platform, and labels a beta one", async () => {
    const { host } = await visit({ ...listWith(["connect"]), providers: () => json({ data: platforms }) });
    await openDialog(host);
    expect(stateOf()).toBe("tiles");
    const startable = all(document.body, "tile-start").map((one) => one.dataset.providerId);
    expect(startable.sort()).toEqual(["a_ga", "b_beta"]);
    // The name of the platform is in each tile's heading, sentence and button (a message placeholder that loses it
    // would leave the sentence and the button without it).
    const tile = document.body.querySelector<HTMLElement>('[data-provider-id="a_ga"]');
    expect(tile?.textContent?.split("Network a_ga")).toHaveLength(4);
    expect(byId(tile as HTMLElement, "tile-start")?.textContent).toContain("Network a_ga");
    expect(all(document.body, "tile-beta")).toHaveLength(1);
    expect(
      byId(document.body, "tile-beta")
        ?.closest('[data-testid="provider-tile"]')
        ?.getAttribute("data-provider-id"),
    ).toBe("b_beta");
  });

  it("says no platform can be connected yet when none is startable", async () => {
    const { host } = await visit({
      ...listWith(["connect"]),
      providers: () => json({ data: [platforms[2], platforms[3]] }),
    });
    await openDialog(host);
    expect(stateOf()).toBe("empty");
    expect(byId(document.body, "tile-start")).toBeNull();
  });

  it("a failed read shows Try again, which reads again, and every opening reads the platforms afresh", async () => {
    let failing = true;
    const { host, stub } = await visit({
      ...listWith(["connect"]),
      providers: () => (failing ? refusal("internal_error", 500) : json({ data: platforms })),
    });
    const before = providerReads(stub).length;
    await openDialog(host);
    expect(stateOf()).toBe("failed");
    failing = false;
    click(byId(document.body, "wizard-retry") as HTMLElement);
    await settle();
    expect(stateOf()).toBe("tiles");
    expect(providerReads(stub)).toHaveLength(before + 2);
    click(byId(document.body, "wizard-cancel") as HTMLElement);
    await settle();
    await openDialog(host);
    expect(providerReads(stub)).toHaveLength(before + 3);
  });
});

describe("closing the dialog, and leaving it behind", () => {
  it("Cancel and Escape close it, send nothing, and give focus back to Add channel", async () => {
    const { host, stub } = await visit(listWith(["connect"]));
    await openDialog(host);
    expect(dialogOf()).not.toBeNull();
    click(byId(document.body, "wizard-cancel") as HTMLElement);
    await settle();
    expect(dialogOf()).toBeNull();
    expect(document.activeElement).toBe(byId(host, "hub-add"));
    await openDialog(host);
    press(dialogOf() as HTMLElement, "Escape");
    await settle();
    expect(dialogOf()).toBeNull();
    expect(document.activeElement).toBe(byId(host, "hub-add"));
    expect(starts(stub)).toHaveLength(0);
  });

  it("a start answered after Cancel never navigates", async () => {
    const assign = spyAssign();
    const late = deferred();
    const { host } = await visit({ ...listWith(["connect"]), connectStart: late.answer });
    await openDialog(host);
    click(startTile());
    await settle();
    click(byId(document.body, "wizard-cancel") as HTMLElement);
    await settle();
    late.release(json({ data: { authorize_url: START_URL } }));
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("a change of workspace", () => {
  // Tenant class (AGENTS 6.13): an answer for the old workspace must not move the browser.
  it("a start answered after the workspace changed never navigates", async () => {
    const assign = spyAssign();
    const late = deferred();
    const workspace = (id: string, name: string) => ({
      id,
      organization_id: "o1",
      name,
      slug: name,
      role: "owner",
    });
    const { host, router } = await visit({
      ...listWith(["connect"]),
      workspaces: pageOf([workspace(CONNECT_WS, "one"), workspace(OTHER, "two")]),
      connectStart: late.answer,
    });
    await openDialog(host);
    click(startTile());
    await settle();
    await act(async () => {
      await router.navigate(`/w/${OTHER}/channels`);
    });
    await settle();
    late.release(json({ data: { authorize_url: START_URL } }));
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });
});
