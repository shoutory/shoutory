import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  openApp,
  pageOf,
  refusal,
  stubApi,
  WORKSPACE_KEY,
  WORKSPACES,
} from "../../test/support/app";

afterEach(closeApp);

const HELP = 'a[href="https://docs.shoutory.com"]';

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

  it("the workspace page shows the first-use state when there is nothing to show", async () => {
    stubApi({ workspaces: () => json({ data: [], meta: { next_cursor: null } }) });
    const { host } = await openApp("/w/w1");
    expect(host.querySelector('main [data-kind="first-use"]')).not.toBeNull();
  });
});

const ARCHIVED = "2026-11-25T10:00:00.000Z";
const archivedOnly = (ids: string[]) =>
  pageOf(WORKSPACES.map((row) => (ids.includes(row.id) ? { ...row, archived_at: ARCHIVED } : row)));

describe("an archived workspace", () => {
  it.each([
    ["a stored workspace that is archived", ["w2"], "w2", "/w/w1"],
    ["the first workspace archived", ["w1"], null, "/w/w2"],
    ["every workspace archived", ["w1", "w2", "w3"], "w2", "/w/w2"],
  ])("`/` with %s lands on an active one while one exists", async (_name, ids, stored, expected) => {
    stubApi({ workspaces: archivedOnly(ids) });
    if (stored) localStorage.setItem(WORKSPACE_KEY, stored);
    const { router } = await openApp("/");
    expect(router.state.location.pathname).toBe(expected);
  });

  it("an archived workspace shows the read-only banner with Restore on its screens, and the switcher marks it", async () => {
    stubApi({ workspaces: archivedOnly(["w1"]) });
    const { host } = await openApp("/w/w1");
    const banner = host.querySelector('main [data-testid="archived-banner"]');
    expect(banner?.textContent).toMatch(/acme one is archived\. it is read-only/i);
    expect(banner?.querySelector('[data-testid="workspace-restore"]')).not.toBeNull();
    click(byText(host, "button", "Ctrl/Cmd+K"));
    const marks = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(marks.slice(0, 2)).toEqual(["Acme One (Archived)", "Acme Two"]);
    closeApp();
    stubApi({ workspaces: archivedOnly(["w1"]) });
    const other = await openApp("/w/w2");
    expect(other.host.querySelector('[data-testid="archived-banner"]')).toBeNull();
  });
});

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
