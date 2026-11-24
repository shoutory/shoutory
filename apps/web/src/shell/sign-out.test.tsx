import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  openApp,
  refusal,
  stubApi,
  WORKSPACE_KEY,
} from "../../test/support/app";

afterEach(closeApp);

const signOutCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([path]) => path.includes("/api/auth/sign-out"));

async function openAccount(path = "/w/w1") {
  const opened = await openApp(path);
  click(byText(opened.host, "button", "Account"));
  return { ...opened, signOut: () => byText<HTMLButtonElement>(document.body, "button", "Sign out") };
}

describe("sign out", () => {
  it("sends a POST with X-Shoutory-Client and an empty body, clears the stored workspace and lands on /sign-in", async () => {
    const stub = stubApi();
    localStorage.setItem(WORKSPACE_KEY, "w2");
    const { router, signOut } = await openAccount("/w/w1");
    click(signOut());
    await act(async () => undefined);
    const [path, init] = signOutCalls(stub)[0] ?? [];
    expect(path).toBe("/api/auth/sign-out");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
    expect(init?.body).toBe("{}");
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("an expired session (401) also lands on /sign-in", async () => {
    stubApi({ signOut: () => refusal("unauthenticated", 401) });
    const { router, signOut } = await openAccount();
    click(signOut());
    await act(async () => undefined);
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("an ended session found by the guard forgets the stored workspace too", async () => {
    stubApi({ session: () => refusal("unauthenticated", 401) });
    localStorage.setItem(WORKSPACE_KEY, "w2");
    const { router } = await openApp("/w/w2");
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
  });

  it.each([
    ["a 500", () => refusal("internal_error", 500)],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("%s keeps the user signed in and says so", async (_name, answer) => {
    stubApi({ signOut: answer });
    const { router, host, signOut } = await openAccount();
    click(signOut());
    await act(async () => undefined);
    expect(router.state.location.pathname).toBe("/w/w1");
    expect(host.querySelector('[role="alert"]') ?? document.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe("sign out while busy or offline", () => {
  it("shows busy and ignores a second press while the call is pending", async () => {
    const stub = stubApi({ signOut: () => new Promise<Response>(() => undefined) });
    const { signOut } = await openAccount();
    click(signOut());
    click(signOut());
    expect(signOutCalls(stub)).toHaveLength(1);
    expect(signOut().getAttribute("aria-busy")).toBe("true");
  });

  it("is aria-disabled with its reason while offline and sends nothing", async () => {
    const stub = stubApi({ signOut: () => json({ success: true }) });
    const { signOut } = await openAccount();
    act(() => void window.dispatchEvent(new Event("offline")));
    const button = signOut();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/offline/i);
    click(button);
    expect(signOutCalls(stub)).toHaveLength(0);
  });
});
