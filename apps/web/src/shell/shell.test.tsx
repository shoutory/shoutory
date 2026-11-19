import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  openApp,
  refusal,
  stubApi,
  WORKSPACE_KEY,
  WORKSPACES,
} from "../../test/support/app";

afterEach(closeApp);

const HELP = 'a[href="https://docs.shoutory.com"]';

// ux-spec X-01, X-08 and 4.10 (SC 2.4.1, 3.2.6): one frame for every signed-in route.
describe("the shell frame", () => {
  it("has landmarks, one Help link in the top bar and exactly one main to skip to", async () => {
    stubApi();
    const { host } = await openApp("/w/w1");
    expect(host.querySelector("header nav, nav")).not.toBeNull();
    expect(host.querySelectorAll(HELP)).toHaveLength(1);
    const help = host.querySelector(`header ${HELP}`);
    expect(help?.getAttribute("target")).toBe("_blank");
    expect(help?.getAttribute("rel")).toMatch(/noopener/);
    expect(help?.getAttribute("rel")).toMatch(/noreferrer/);
    expect(help?.getAttribute("aria-label")).toMatch(/new tab/i);
    expect(host.querySelectorAll("main")).toHaveLength(1);
    expect(host.querySelector("main#main")?.getAttribute("tabindex")).toBe("-1");
  });

  it("the skip link is the first link and moves focus into main", async () => {
    stubApi();
    const { host } = await openApp("/w/w1");
    const skip = host.querySelector<HTMLAnchorElement>("a");
    expect(skip?.getAttribute("href")).toBe("#main");
    click(skip as HTMLElement);
    expect(host.querySelector("main#main")?.contains(document.activeElement)).toBe(true);
  });
});

function unreadableStorage() {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage is blocked");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  });
}

// R392 and R397: `/` opens the last-used workspace, else the first; a stale or unreadable id never blocks.
describe("opening a workspace", () => {
  it.each([
    ["nothing stored", null, "/w/w1"],
    ["a stored workspace", "w2", "/w/w2"],
    ["a stored id that no longer exists", "gone", "/w/w1"],
    ["unreadable storage", "throws", "/w/w1"],
  ])("`/` with %s opens the expected workspace", async (_name, stored, expected) => {
    stubApi();
    if (stored === "throws") unreadableStorage();
    else if (stored) localStorage.setItem(WORKSPACE_KEY, stored);
    const { router } = await openApp("/");
    expect(router.state.location.pathname).toBe(expected);
  });

  it("remembers the workspace that was opened", async () => {
    stubApi();
    await openApp("/w/w2");
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe("w2");
  });

  it("an id that is not one of my workspaces is the not-found page", async () => {
    stubApi();
    const { host } = await openApp("/w/nope");
    expect(host.querySelector("h1")?.textContent).toBe("Page not found");
    expect(document.title).toBe("Page not found - Shoutory");
  });

  it.each([
    ["the workspace page", "/w/w1"],
    ["the start page with no workspace at all", "/"],
  ])("%s shows the first-use state when there is nothing to show", async (_name, path) => {
    stubApi({ workspaces: () => json({ data: [], meta: { next_cursor: null } }) });
    const { host } = await openApp(path);
    expect(host.querySelector('main [data-kind="first-use"]')).not.toBeNull();
  });
});

// ux-spec 2.1 X: a failed list is an inline panel in the top bar; the rail and the top bar stay.
describe("a failed list", () => {
  it.each([
    ["the workspaces", { workspaces: () => refusal("internal_error", 500) }],
    ["the organizations", { organizations: () => refusal("service_unavailable", 503) }],
  ])("%s fails inline: the panel is in the top bar and the frame stays", async (_name, api) => {
    stubApi(api);
    const { host } = await openApp("/w/w1");
    expect(host.querySelector('header [role="alert"]')?.textContent).toContain("Details");
    expect(host.querySelector("nav")).not.toBeNull();
    expect(host.querySelectorAll(HELP)).toHaveLength(1);
    expect(host.querySelector("main#main")).not.toBeNull();
  });

  it("Retry asks for the lists again and the panel goes once they load", async () => {
    let calls = 0;
    const stub = stubApi({
      workspaces: () =>
        ++calls === 1
          ? refusal("internal_error", 500)
          : json({ data: WORKSPACES, meta: { next_cursor: null } }),
    });
    const { host } = await openApp("/w/w1");
    click(byText(host, 'header [role="alert"] button', "Retry"));
    await act(async () => undefined);
    expect(stub.mock.calls.filter(([path]) => path.includes("/api/v1/workspaces"))).toHaveLength(2);
    expect(host.querySelector('header [role="alert"]')).toBeNull();
  });
});

// ux-spec 2.1 L (R397 10): nothing for 300 ms, then a skeleton, then "Still loading" with Retry after 10 s.
describe("while the lists load", () => {
  it.each([
    ["299 ms", 299, ""],
    ["301 ms", 301, "Loading"],
    ["10.1 s", 10_100, "Still loading"],
  ])("after %s the page shows the expected status", async (_name, elapsed, expected) => {
    vi.useFakeTimers();
    stubApi({ workspaces: () => new Promise<Response>(() => undefined) });
    const { host } = await openApp("/w/w1");
    await act(() => vi.advanceTimersByTimeAsync(elapsed));
    const shown = host.querySelector('[role="status"]')?.textContent ?? "";
    if (expected === "") expect(shown).toBe("");
    else expect(shown).toContain(expected);
    if (elapsed > 10_000) expect(byText(host, "button", "Retry")).toBeDefined();
  });
});
