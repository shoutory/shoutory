import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
  pageOf,
  refusal,
  settle,
  stubApi,
  uuidWorkspaces,
} from "../../../test/support/app";
import { setZone } from "../../account/prefs";

afterEach(closeApp);

const PATH = `/w/${CONNECT_WS}/channels`;
const UNLISTED = "0190a000-0000-7000-8000-0000000000c2";
const idOf = (n: number) => `0190a000-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`;
const row = (n: number, change: Record<string, unknown> = {}) =>
  channelRow({ id: idOf(n), display_name: `Channel ${n}`, handle: `@channel_${n}`, ...change });

const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const byId = (host: ParentNode, id: string) => all(host, id)[0] ?? null;
const cards = (host: ParentNode) => all(host, "channel-card");
const card = (host: ParentNode, n: number) => cards(host).find((one) => one.dataset.channelId === idOf(n));
const part = (host: ParentNode, n: number, id: string) =>
  card(host, n) ? byId(card(host, n) as HTMLElement, id) : null;
const stateOf = (host: ParentNode) => byId(host, "hub-state")?.dataset.state;

async function visit(api: Api = {}, path = PATH) {
  const stub = stubApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(path);
  await settle();
  return { stub, ...opened };
}
const listOf = (...rows: unknown[]): Api => ({ channelList: () => channelPage(rows) });
const listCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url]) => /\/channels(\?|$)/.test(url));
const checks = (stub: ReturnType<typeof stubApi>) => callsTo(stub, "POST", "/check");
function deferred() {
  let release: (answer: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { answer: () => promise, release };
}

describe("the hub page", () => {
  it.each<[string, () => Api, string, boolean]>([
    ["loading", () => ({ channelList: deferred().answer }), "loading", false],
    ["first use, no channel yet", () => listOf(), "empty", false],
    [
      "a failed read, with Try again",
      () => ({ channelList: () => refusal("internal_error", 500) }),
      "failed",
      true,
    ],
    ["a 403, with no retry", () => ({ channelList: () => refusal("forbidden", 403) }), "forbidden", false],
    [
      "a page whose cursor is not a UUID",
      () => ({ channelList: () => channelPage([row(1)], "not-a-uuid") }),
      "failed",
      true,
    ],
    ["channels", () => listOf(row(1)), "list", false],
  ])("%s", async (_name, api, state, retry) => {
    const { host } = await visit(api());
    expect(stateOf(host)).toBe(state);
    expect(byId(host, "hub-heading")).not.toBeNull();
    expect(byId(host, "hub-retry") !== null).toBe(retry);
    expect(host.querySelector('[role="alert"]') !== null).toBe(state === "failed" || state === "forbidden");
    expect(cards(host)).toHaveLength(state === "list" ? 1 : 0);
  });

  it("a failed read is read again by Try again, and then lists the channels", async () => {
    let failing = true;
    const { host, stub } = await visit({
      channelList: () => (failing ? refusal("internal_error", 500) : channelPage([row(1)])),
    });
    failing = false;
    click(byId(host, "hub-retry") as HTMLElement);
    await settle();
    expect(stateOf(host)).toBe("list");
    expect(listCalls(stub)).toHaveLength(2);
  });

  it("a workspace that is not in the person's list is the not-found page and reads nothing", async () => {
    const { host, stub } = await visit({}, `/w/${UNLISTED}/channels`);
    expect(byId(host, "not-found")).not.toBeNull();
    expect(listCalls(stub)).toHaveLength(0);
  });

  it.each([PATH, `/w/${CONNECT_WS}`])("the rail of %s links to the hub", async (path) => {
    const { host } = await visit({}, path);
    expect(host.querySelector(`nav a[href="${PATH}"]`)).not.toBeNull();
  });
});

describe("Show more", () => {
  const first = () => channelPage([row(1), row(2)], idOf(2));
  const second = () => channelPage([row(3)]);

  it("follows the cursor, appends the next page in order and goes away at the last page", async () => {
    const { host, stub } = await visit({
      channelList: (query) => (query.get("cursor") === idOf(2) ? second() : first()),
    });
    expect(cards(host)).toHaveLength(2);
    expect(listCalls(stub)[0]?.[0]).not.toMatch(/cursor|limit/);
    click(byId(host, "hub-more") as HTMLElement);
    await settle();
    expect(cards(host).map((one) => one.dataset.channelId)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(listCalls(stub)[1]?.[0]).toContain(`cursor=${idOf(2)}`);
    expect(byId(host, "hub-more")).toBeNull();
  });

  it("lists a channel once when the next page repeats one", async () => {
    const { host } = await visit({
      channelList: (query) => (query.get("cursor") === idOf(2) ? channelPage([row(2), row(3)]) : first()),
    });
    click(byId(host, "hub-more") as HTMLElement);
    await settle();
    expect(cards(host).map((one) => one.dataset.channelId)).toEqual([idOf(1), idOf(2), idOf(3)]);
  });

  it("keeps the rows when the next page fails, says so, and loads it on the next press", async () => {
    let failing = true;
    const { host } = await visit({
      channelList: (query) => {
        if (query.get("cursor") !== idOf(2)) return first();
        return failing ? refusal("internal_error", 500) : second();
      },
    });
    click(byId(host, "hub-more") as HTMLElement);
    await settle();
    expect(cards(host)).toHaveLength(2);
    expect(byId(host, "hub-more-error")).not.toBeNull();
    expect(byId(host, "hub-more")).not.toBeNull();
    failing = false;
    click(byId(host, "hub-more") as HTMLElement);
    await settle();
    expect(cards(host)).toHaveLength(3);
    expect(byId(host, "hub-more-error")).toBeNull();
  });
});

describe("the provider of a card", () => {
  it("is named from the providers read, and by its id in isolated text when the read failed", async () => {
    const named = await visit(listOf(row(1)));
    expect(part(named.host, 1, "card-provider")?.textContent).toBe("Fixture Network");
    closeApp();
    const failed = await visit({ ...listOf(row(1)), providers: () => refusal("internal_error", 500) });
    expect(stateOf(failed.host)).toBe("list");
    expect(part(failed.host, 1, "card-provider")?.textContent).toBe("fixture_oauth");
    expect(part(failed.host, 1, "card-provider")?.querySelector("bdi")).not.toBeNull();
  });

  it("shows the id of a provider the read does not list", async () => {
    const { host } = await visit(listOf(row(1, { provider_id: "fixture_other" })));
    expect(part(host, 1, "card-provider")?.textContent).toBe("fixture_other");
  });
});

const CHECKED = "2026-11-22T10:00:00.000Z";
describe("the state and health words of a card", () => {
  it.each<[string, string, string | null, string | null, string | null]>([
    ["connected", "ok", CHECKED, "connected", "ok"],
    ["connected", "degraded", CHECKED, "connected", "degraded"],
    ["connected", "failing", CHECKED, "connected", "failing"],
    ["connected", "ok", null, "connected", "unknown"],
    ["connected", "ok", "not a date", "connected", "unknown"],
    ["connected", "degraded", null, "connected", "degraded"],
    ["connected", "failing", null, "connected", "failing"],
    ["connected", null as unknown as string, CHECKED, "connected", "unknown"],
    ["connected", "a_health_not_known_yet", CHECKED, "connected", "unknown"],
    ["needs_reconnect", "ok", CHECKED, "needs_reconnect", null],
    ["revoked_by_provider", "failing", CHECKED, "revoked_by_provider", null],
    ["a_state_not_known_yet", "ok", CHECKED, "unknown", null],
  ])(
    "%s with health %s and check time %s reads state %s and health %s",
    async (state, health, checked, wantState, wantHealth) => {
      const { host } = await visit(
        listOf(row(1, { connection_state: state, health, health_checked_at: checked })),
      );
      expect(part(host, 1, "card-state")?.dataset.state).toBe(wantState);
      expect(part(host, 1, "card-health")?.dataset.health ?? null).toBe(wantHealth);
      const known = wantHealth !== null && wantHealth !== "unknown";
      expect(part(host, 1, "card-checked") !== null).toBe(known && checked !== null);
    },
  );

  it("uses a different word for every state and every health, and Connected is only the connected state's", async () => {
    const states = [
      "connected",
      "needs_reconnect",
      "disconnected",
      "revoked_by_provider",
      "disabled",
      "other_state",
    ];
    const healths = ["ok", "degraded", "failing", "unknown"];
    const rows = [
      ...states.map((state, index) => row(index + 1, { connection_state: state })),
      ...healths.map((health, index) =>
        row(index + 7, { connection_state: "connected", health: health === "unknown" ? null : health }),
      ),
    ];
    const { host } = await visit(listOf(...rows));
    const words = (id: string, key: "state" | "health") =>
      new Map(all(host, id).map((one) => [one.dataset[key], one.textContent]));
    expect(new Set(words("card-state", "state").values()).size).toBe(6);
    expect(new Set(words("card-health", "health").values()).size).toBe(4);
  });
});

describe("the dates of a card", () => {
  it("names the zone of the check time and keeps the instant", async () => {
    setZone("UTC");
    const { host } = await visit(listOf(row(1, { health: "ok", health_checked_at: CHECKED })));
    const time = part(host, 1, "card-checked")?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(CHECKED);
    expect(time?.textContent).toContain("UTC");
  });

  it.each([
    ["needs_reconnect", true],
    ["disconnected", true],
    ["revoked_by_provider", true],
    ["connected", false],
    ["disabled", false],
  ])("a %s channel with a reconnect deadline shows it: %s", async (state, shown) => {
    const { host } = await visit(
      listOf(row(1, { connection_state: state, reconnect_deadline: "2026-12-01T00:00:00.000Z" })),
    );
    expect(part(host, 1, "card-deadline") !== null).toBe(shown);
    if (shown) expect(part(host, 1, "card-deadline")?.querySelector("time")).not.toBeNull();
  });
});

describe("the name part of a card", () => {
  it.each([
    ["two words", "Acme Page", "AP"],
    ["one word", "acme", "A"],
    ["an emoji first", "😀 Party", "😀P"],
    ["an Arabic name", "قناة الشركة", "قا"],
    ["only spaces", "   ", "?"],
  ])("initials of %s", async (_what, name, initials) => {
    const { host } = await visit(listOf(row(1, { display_name: name })));
    expect(part(host, 1, "card-initials")?.textContent).toBe(initials);
  });

  it("never renders the avatar, even when the answer has one", async () => {
    const url = "https://cdn.example.test/avatar.png";
    const { host } = await visit(listOf(row(1, { avatar: url })));
    expect(card(host, 1)?.querySelector("img")).toBeNull();
    expect(card(host, 1)?.innerHTML).not.toContain(url);
  });

  it("shows the display name, the nickname and the handle as isolated text, and nothing for a missing one", async () => {
    const { host } = await visit(listOf(row(1, { nickname: "Brand page" }), row(2, { handle: null })));
    expect(part(host, 1, "card-display-name")?.textContent).toBe("Channel 1");
    expect(part(host, 1, "card-nickname")?.textContent).toBe("Brand page");
    expect(part(host, 1, "card-handle")?.querySelector("bdi")?.textContent).toBe("@channel_1");
    expect(part(host, 2, "card-nickname")).toBeNull();
    expect(part(host, 2, "card-handle")).toBeNull();
  });
});

describe("Check now", () => {
  it.each([
    ["check", ["check"], true],
    ["nothing", [], false],
    ["only reconnect", ["reconnect"], false],
  ])("is offered only where the row's actions list check: %s", async (_what, actions, offered) => {
    const { host } = await visit(listOf(row(1, { actions })));
    expect(part(host, 1, "card-check") !== null).toBe(offered);
  });

  it("replaces the card with the answered row, after one POST to that channel", async () => {
    const { host, stub } = await visit({
      ...listOf(row(1)),
      check: () => json({ data: row(1, { health: "failing", health_checked_at: CHECKED }) }),
    });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(part(host, 1, "card-health")?.dataset.health).toBe("failing");
    expect(checks(stub).map(([url]) => url)).toEqual([
      `/api/v1/workspaces/${CONNECT_WS}/channels/${idOf(1)}/check`,
    ]);
  });

  it.each<[string, () => Response, string]>([
    ["409 not_connected", () => refusal("conflict", 409, { reason: "not_connected" }), "not_connected"],
    [
      "409 provider_unavailable",
      () => refusal("conflict", 409, { reason: "provider_unavailable" }),
      "provider_unavailable",
    ],
    ["429", () => refusal("too_many_requests", 429), "rate_limited"],
    ["403", () => refusal("forbidden", 403), "forbidden"],
    ["500", () => refusal("internal_error", 500), "failed"],
  ])("a %s is explained on the card, with no time", async (_what, answer, reason) => {
    const { host } = await visit({ ...listOf(row(1)), check: answer });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    const said = part(host, 1, "card-check-error");
    expect(said?.dataset.reason).toBe(reason);
    expect(said?.textContent?.length).toBeGreaterThan(0);
    expect(said?.textContent).not.toMatch(/\d/);
  });
});

describe("Check now, when the channel changed or went away", () => {
  it("a 409 not_connected shows the channel's current state from a fresh read", async () => {
    const { host, stub } = await visit({
      ...listOf(row(1)),
      check: () => refusal("conflict", 409, { reason: "not_connected" }),
      channel: () => json({ data: row(1, { connection_state: "needs_reconnect", actions: ["reconnect"] }) }),
    });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(part(host, 1, "card-state")?.dataset.state).toBe("needs_reconnect");
    expect(part(host, 1, "card-check")).toBeNull();
    expect(callsTo(stub, "GET", `/channels/${idOf(1)}`)).toHaveLength(1);
  });

  it("a 404 drops the card and says so once, above the list", async () => {
    const { host } = await visit({ ...listOf(row(1), row(2)), check: () => refusal("not_found", 404) });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(card(host, 1)).toBeUndefined();
    expect(card(host, 2)).not.toBeUndefined();
    const notices = all(host, "hub-notice");
    expect(notices).toHaveLength(1);
    const [notice] = notices as [HTMLElement];
    expect(notice.dataset.reason).toBe("not_found");
    expect(
      notice.compareDocumentPosition(card(host, 2) as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a second press while the first is pending sends no second POST, and the button says it is busy", async () => {
    const pending = deferred();
    const { host, stub } = await visit({ ...listOf(row(1)), check: pending.answer });
    click(part(host, 1, "card-check") as HTMLElement);
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(part(host, 1, "card-check")?.getAttribute("aria-busy")).toBe("true");
    pending.release(json({ data: row(1, { health: "ok", health_checked_at: CHECKED }) }));
    await settle();
    expect(checks(stub)).toHaveLength(1);
  });
});

describe("Check now, when the fresh read after a 409 not_connected fails", () => {
  it.each([
    ["a 404", () => refusal("not_found", 404), null],
    ["a failure", () => refusal("internal_error", 500), "failed"],
  ])("answering %s", async (_what, read, reason) => {
    const { host } = await visit({
      ...listOf(row(1)),
      check: () => refusal("conflict", 409, { reason: "not_connected" }),
      channel: read,
    });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(part(host, 1, "card-check-error")?.dataset.reason ?? null).toBe(reason);
    expect(card(host, 1) === undefined).toBe(reason === null);
    expect(byId(host, "hub-notice") !== null).toBe(reason === null);
  });
});

describe("Check now, for a person using a screen reader or a session that ended", () => {
  it("is described by its card's display name, so several buttons are told apart", async () => {
    const { host } = await visit(listOf(row(1), row(2)));
    for (const n of [1, 2]) {
      const named = part(host, n, "card-display-name");
      expect(named?.id).toBeTruthy();
      expect(part(host, n, "card-check")?.getAttribute("aria-describedby")).toBe(named?.id);
    }
  });

  it("a session that ended during the check goes to sign-in and comes back to this page", async () => {
    const { router, host } = await visit({
      ...listOf(row(1)),
      check: () => refusal("unauthenticated", 401),
    });
    click(part(host, 1, "card-check") as HTMLElement);
    await settle();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe(`?return-to=${encodeURIComponent(PATH)}`);
  });
});

describe("where focus goes when a control disappears", () => {
  it.each<[string, () => Api, (host: HTMLElement) => HTMLElement | null | undefined]>([
    [
      "Show more after the last page: the first appended card",
      () => ({
        channelList: (query) =>
          query.get("cursor") === idOf(2) ? channelPage([row(3)]) : channelPage([row(1), row(2)], idOf(2)),
      }),
      (host) => card(host, 3),
    ],
    [
      "a replaced card that no longer offers Check now: the card",
      () => ({
        ...listOf(row(1)),
        check: () => json({ data: row(1, { connection_state: "needs_reconnect", actions: [] }) }),
      }),
      (host) => card(host, 1),
    ],
  ])("%s", async (name, api, target) => {
    const { host } = await visit(api());
    click((byId(host, "hub-more") ?? part(host, 1, "card-check")) as HTMLElement);
    await settle();
    const focused = target(host);
    expect(focused).toBeTruthy();
    expect(document.activeElement).toBe(focused);
    expect(focused?.getAttribute("tabindex")).toBe("-1");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("a change of workspace", () => {
  const workspace = (id: string, name: string) => ({
    id,
    organization_id: "o1",
    name,
    slug: name,
    role: "owner",
  });

  it("starts from loading, and neither a row nor a late page of the old workspace shows under the new one", async () => {
    const [late, other] = [deferred(), deferred()];
    const { host, router } = await visit({
      workspaces: pageOf([workspace(CONNECT_WS, "one"), workspace(UNLISTED, "two")]),
      channelList: (query, id) => {
        if (id === UNLISTED) return other.answer();
        return query.get("cursor") === idOf(2) ? late.answer() : channelPage([row(1), row(2)], idOf(2));
      },
    });
    click(byId(host, "hub-more") as HTMLElement);
    await settle();
    await act(async () => {
      await router.navigate(`/w/${UNLISTED}/channels`);
    });
    await settle();
    expect(stateOf(host)).toBe("loading");
    expect(cards(host)).toHaveLength(0);
    late.release(channelPage([row(3)]));
    await settle();
    expect(cards(host)).toHaveLength(0);
    other.release(channelPage([row(5)]));
    await settle();
    expect(cards(host).map((one) => one.dataset.channelId)).toEqual([idOf(5)]);
  });
});
