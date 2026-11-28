import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_WS,
  channelPage,
  channelRow,
  click,
  closeApp,
  openApp,
  settle,
  uuidWorkspaces,
} from "../../../test/support/app";
import { type ChannelApi, providersWith, stubChannelApi } from "../../../test/support/channel-api";
import { setZone } from "../../account/prefs";

afterEach(closeApp);

const idOf = (n: number) => `0190a000-0000-7000-8000-00000000f${String(n).padStart(3, "0")}`;
const row = (n: number, change: Record<string, unknown> = {}) =>
  channelRow({ id: idOf(n), display_name: `Channel ${n}`, handle: `@channel_${n}`, ...change });

const FIRST = { id: "alpha_net", display_name: "Alpha Net" };
const SECOND = { id: "beta_net", display_name: "Beta Net", capabilities: ["text", "image", "mystery"] };

async function visit(api: ChannelApi) {
  stubChannelApi({ workspaces: uuidWorkspaces(), ...api });
  const opened = await openApp(`/w/${CONNECT_WS}/channels`);
  await settle();
  return opened.host;
}
const listOf = (...rows: unknown[]): ChannelApi => ({ channelList: () => channelPage(rows) });
const all = (host: ParentNode, id: string) => [
  ...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const ids = (host: ParentNode) => all(host, "channel-card").map((one) => one.dataset.channelId);
const toggle = (host: ParentNode) => host.querySelector<HTMLElement>('[role="switch"]');

describe("the hub groups", () => {
  it("lists the cards under one heading per platform, named from the providers answer", async () => {
    const host = await visit({
      ...listOf(
        row(1, { provider_id: "beta_net" }),
        row(2, { provider_id: "alpha_net" }),
        row(3, { provider_id: "beta_net" }),
      ),
      providers: providersWith(FIRST, SECOND),
    });
    const groups = [...host.querySelectorAll("section[aria-labelledby]")];
    expect(groups.map((group) => group.querySelector("h2")?.textContent)).toEqual(["Alpha Net", "Beta Net"]);
    const inGroup = groups.map((group) =>
      [...group.querySelectorAll<HTMLElement>('[data-testid="channel-card"]')].map(
        (one) => one.dataset.channelId,
      ),
    );
    expect(inGroup).toEqual([[idOf(2)], [idOf(1), idOf(3)]]);
  });

  it("names a platform the providers answer lacks by its id", async () => {
    const host = await visit({
      ...listOf(row(1, { provider_id: "gone_net" })),
      providers: providersWith(FIRST),
    });
    expect(host.querySelector("section[aria-labelledby] h2")?.textContent).toBe("gone_net");
  });

  it("links each card to the detail page of its channel", async () => {
    const host = await visit(listOf(row(1)));
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="card-display-name"] a');
    expect(link?.getAttribute("href")).toBe(`/w/${CONNECT_WS}/channels/${idOf(1)}`);
  });
});

describe("the Needs attention filter", () => {
  const mixed = () =>
    listOf(
      row(1),
      row(2, { connection_state: "needs_reconnect", actions: ["reconnect"] }),
      row(3, { connection_state: "disabled", actions: ["enable"] }),
      row(4, { actions: ["check", "reconnect"] }),
    );

  it("shows only the cards that are broken or that list reconnect, never one that was turned off, and Clear filters restores all", async () => {
    const host = await visit(mixed());
    expect(ids(host)).toHaveLength(4);
    click(toggle(host) as HTMLElement);
    expect(ids(host)).toEqual([idOf(2), idOf(4)]);
    click(toggle(host) as HTMLElement);
    expect(ids(host)).toHaveLength(4);
  });

  it("says no channel matches when every card is connected, with a way out", async () => {
    const host = await visit(listOf(row(1), row(2)));
    click(toggle(host) as HTMLElement);
    const empty = host.querySelector('[data-kind="filtered-out"]');
    expect(empty?.querySelector("h2")?.textContent).toBe("No channels match");
    expect(ids(host)).toHaveLength(0);
    const clear = [...(empty?.querySelectorAll("button") ?? [])][0];
    click(clear as HTMLElement);
    expect(ids(host)).toHaveLength(2);
    expect((toggle(host) as HTMLInputElement).checked).toBe(false);
  });
});

describe("the token expiry hint", () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ["a connected channel with an end date", { token_expires_at: "2026-12-20T09:30:00.000Z" }, true],
    ["a connected channel with no end date", { token_expires_at: null }, false],
    [
      "a channel that needs reconnecting, whatever its old date",
      { connection_state: "needs_reconnect", token_expires_at: "2026-11-01T09:30:00.000Z", actions: [] },
      false,
    ],
  ])("%s", async (_name, change, shown) => {
    setZone("UTC");
    const host = await visit(listOf(row(1, change)));
    const hint = host.querySelector('[data-testid="card-expiry"]');
    expect(hint !== null).toBe(shown);
    if (shown) {
      expect(hint?.textContent).toMatch(/^Access ends /);
      expect(hint?.querySelector("time")?.getAttribute("datetime")).toBe("2026-12-20T09:30:00.000Z");
    }
  });
});

describe("the capability chips", () => {
  it.each<[string, Record<string, unknown>, string[]]>([
    ["the words of the listed capabilities, none for a value it does not know", SECOND, ["Text", "Images"]],
    ["no chips from a provider that lists none", FIRST, []],
  ])("%s", async (_name, provider, chips) => {
    const host = await visit({
      ...listOf(row(1, { provider_id: String(provider.id) })),
      providers: providersWith(provider),
    });
    expect(all(host, "card-capability").map((chip) => chip.textContent)).toEqual(chips);
  });
});
