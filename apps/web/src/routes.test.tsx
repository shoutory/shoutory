import { i18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeApp, openApp, stubApi } from "../test/support/app";
import { routes } from "./routes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalogs = import.meta.glob<{ messages: Messages }>("./messages/*.po", { eager: true });
const SESSION = {
  data: {
    session: { id: "s1", expiresAt: "2026-12-01T00:00:00Z" },
    user: { id: "u1", name: "Person Sample", email: "person@example.test", emailVerified: true },
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refusal = (code: string, status: number) =>
  json({ error: { code, message: "words the user must never see", requestId: "req-42" } }, status);

let root: Root | undefined;
let fetchStub = vi.fn();

beforeAll(() => {
  i18n.load("en", catalogs["./messages/en.po"]?.messages ?? {});
  i18n.activate("en");
});

afterEach(() => {
  closeApp();
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function visit(path: string, answer?: () => Promise<Response>) {
  fetchStub = vi.fn(answer ?? (() => Promise.resolve(json(SESSION))));
  vi.stubGlobal("fetch", fetchStub);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>,
    );
  });
  return { router, host };
}

describe("the session guard (R378)", () => {
  // The shell loader asks for the organizations and workspaces too, so each path has its own answer (the harness).
  it("lets a signed-in visitor in: `/` opens the first workspace in the shell", async () => {
    stubApi();
    const { host, router } = await openApp("/");
    expect(router.state.location.pathname).toBe("/w/w1");
    expect(host.querySelector("main h1")?.textContent).toBe("Acme One");
  });

  it("sends a signed-out visitor to sign-in with the page they asked for", async () => {
    const { router, host } = await visit("/", () => Promise.resolve(refusal("unauthenticated", 401)));
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe("?return-to=%2F");
    expect(host.querySelector("h1")?.textContent).toBe("Sign in");
  });

  it.each([
    [
      "session-expired, a protocol-relative URL",
      `/session-expired?return-to=${encodeURIComponent("//evil.example.test")}`,
      "/sign-in?return-to=%2F",
    ],
    [
      "session-expired, a path on this origin",
      `/session-expired?return-to=${encodeURIComponent("/calendar")}`,
      "/sign-in?return-to=%2Fcalendar",
    ],
  ])("the link on %s follows only a path on this origin", async (_name, path, expected) => {
    const { host } = await visit(path);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(expected);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// X-07: each failure has its own page, with its own words and no status code, stack trace or server text.
describe("system pages", () => {
  it.each([
    [
      "a 503",
      () => Promise.resolve(refusal("service_unavailable", 503)),
      "Shoutory is not reachable right now",
    ],
    [
      "a network failure",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Shoutory is not reachable right now",
    ],
    ["a 403", () => Promise.resolve(refusal("forbidden", 403)), "You do not have access to this page"],
    ["a 500", () => Promise.resolve(refusal("internal_error", 500)), "Shoutory did not start correctly"],
    [
      "an answer that is not the contract",
      () => Promise.resolve(json({ data: 1 })),
      "Shoutory did not start correctly",
    ],
  ])("%s while the guard asks shows its own page", async (_name, answer, title) => {
    const { host } = await visit("/", answer);
    expect(host.querySelector("h1")?.textContent).toBe(title);
    const shown = host.textContent ?? "";
    expect(shown).not.toMatch(/words the user must never see|api call failed|\b50[03]\b|\bat \w+ \(/);
  });

  it("the start-up failure page keeps the request id behind a disclosure", async () => {
    const { host } = await visit("/", () => Promise.resolve(refusal("internal_error", 500)));
    expect(host.querySelector("details summary")?.textContent).toBe("Details");
    expect(host.querySelector("details")?.textContent).toContain("req-42");
  });

  it("an unknown address is the not-found page and asks no one", async () => {
    const { host } = await visit("/no/such/page");
    expect(host.querySelector("h1")?.textContent).toBe("Page not found");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("the session-expired page has its own words", async () => {
    const { host } = await visit("/session-expired");
    expect(host.querySelector("h1")?.textContent).toBe("Your session has ended");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("while the guard waits", () => {
  it.each([
    ["299 ms", 299, ""],
    ["301 ms", 301, "Loading"],
  ])("after %s the page shows %j", async (_name, elapsed, expected) => {
    vi.useFakeTimers();
    fetchStub = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchStub);
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <I18nProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nProvider>,
      );
    });
    await act(() => vi.advanceTimersByTimeAsync(elapsed));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(expected);
  });
});
