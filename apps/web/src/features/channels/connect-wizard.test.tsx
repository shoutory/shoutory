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
  type,
  uuidWorkspaces,
} from "../../../test/support/app";

afterEach(() => {
  closeApp();
  vi.restoreAllMocks();
});

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

async function visit(api: Api = {}, path = PATH, locale: "en" | "ar" = "en") {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(path, locale);
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
    // A response body is read once, so a start after the page showed again needs its own answer.
    let calls = 0;
    const { host, stub } = await visit({
      ...listWith(["connect"]),
      providers: () => json({ data: [provider("a_ga"), provider("b_ga")] }),
      connectStart: () => (calls++ === 0 ? pending.answer() : json({ data: { authorize_url: START_URL } })),
    });
    await openDialog(host);
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

const withInstance = (more: Api = {}): Api => ({
  ...listWith(["connect"]),
  providers: () => json({ data: [provider("i_net", { needs_instance_host: true })] }),
  ...more,
});
const hostField = () => byId(document.body, "host-field") as HTMLInputElement;
async function askHost(api: Api = withInstance(), locale: "en" | "ar" = "en") {
  const visited = await visit(api, PATH, locale);
  await openDialog(visited.host);
  click(startTile());
  await settle();
  return visited;
}
async function submitHost(value: string) {
  type(hostField(), value);
  click(byId(document.body, "host-continue") as HTMLElement);
  await settle();
}

describe("a platform whose accounts live on servers people choose", () => {
  it("asks for the server first, sends the typed address in its one stored form, and is busy with Back held until the answer", async () => {
    const assign = spyAssign();
    const pending = deferred();
    const { stub } = await askHost(withInstance({ connectStart: pending.answer }));
    expect(starts(stub)).toHaveLength(0);
    expect(document.activeElement).toBe(hostField());
    expect(hostField().getAttribute("dir")).toBe("ltr");
    await submitHost(" HTTPS://Town.Example./about ");
    const [[, init]] = starts(stub) as [[string, RequestInit]];
    expect(JSON.parse(String(init.body))).toEqual({ instance_host: "town.example" });
    expect(byId(document.body, "host-continue")?.getAttribute("aria-busy")).toBe("true");
    click(byId(document.body, "host-back") as HTMLElement);
    await settle();
    expect(hostField()).not.toBeNull();
    expect(assign).not.toHaveBeenCalled();
    pending.release(json({ data: { authorize_url: START_URL } }));
    await settle();
    expect(assign).toHaveBeenCalledWith(new URL(START_URL).href);
  });

  it("Back after a refused server clears its error and returns to the tile that opened the step", async () => {
    await askHost(
      withInstance({
        connectStart: () => refusal("service_unavailable", 503, { reason: "instance_unreachable" }),
      }),
    );
    await submitHost("town.example");
    expect(byId(document.body, "start-error")).not.toBeNull();
    click(byId(document.body, "host-back") as HTMLElement);
    await settle();
    expect(hostField()).toBeNull();
    expect(stateOf()).toBe("tiles");
    expect(byId(document.body, "start-error")).toBeNull();
    expect(document.activeElement).toBe(startTile());
  });

  it.each(["10.0.0.5", "http://town.example", "town", "user@town.example"])(
    "refuses %j at the field, puts focus back on it, and sends nothing",
    async (value) => {
      const { stub } = await askHost();
      type(hostField(), value);
      const send = byId(document.body, "host-continue") as HTMLElement;
      send.focus();
      click(send);
      await settle();
      expect(hostField().getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(hostField());
      expect(starts(stub)).toHaveLength(0);
    },
  );
});

describe("the reasons a server address was refused", () => {
  it.each<[string, () => Response]>([
    ["host_invalid", () => refusal("unprocessable_content", 422, { reason: "host_invalid" })],
    ["account_not_found", () => refusal("unprocessable_content", 422, { reason: "account_not_found" })],
    ["instance_unsupported", () => refusal("unprocessable_content", 422, { reason: "instance_unsupported" })],
    ["address_not_allowed", () => refusal("unprocessable_content", 422, { reason: "address_not_allowed" })],
    ["instance_refused", () => refusal("unprocessable_content", 422, { reason: "instance_refused" })],
    ["instance_rate_limited", () => refusal("too_many_requests", 429, { reason: "instance_rate_limited" })],
    ["instance_unreachable", () => refusal("service_unavailable", 503, { reason: "instance_unreachable" })],
  ])("the reason %s has its own line in English and Arabic", async (reason, answer) => {
    const said: string[] = [];
    for (const locale of ["en", "ar"] as const) {
      await askHost(withInstance({ connectStart: answer }), locale);
      await submitHost("town.example");
      const line = byId(document.body, "start-error");
      expect(line?.dataset.reason).toBe(reason);
      said.push(line?.textContent ?? "");
      closeApp();
    }
    const [en = "", ar = ""] = said;
    expect(en).not.toMatch(/something went wrong|too many connection attempts/i);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
  });
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
  it("a start answered after the workspace changed never navigates", async () => {
    const assign = spyAssign();
    const late = deferred();
    const workspace = (id: string, name: string) => ({
      id,
      organization_id: "o1",
      name,
      slug: name,
      role: "owner",
      archived_at: null,
      avatar: null,
      organization_type: "agency",
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
