import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { closeApp, openApp, refusal, stubApi } from "../test/support/app";

afterEach(closeApp);

// ux-spec 4.10 SC 2.4.2 and 2.4.3: a route change sets the translated title and focuses the new page's h1; the first
// load moves nothing; only a change of path counts (R397 6).
describe("a route change", () => {
  it.each<["en" | "ar", string, string, string]>([
    ["en", "/sign-in", "/session-expired", "Your session has ended"],
    ["en", "/session-expired", "/no/such/page", "Page not found"],
    ["ar", "/session-expired", "/sign-in", "تسجيل الدخول"],
  ])("in %s from %s to %s titles the page %j and focuses its h1", async (locale, from, to, page) => {
    stubApi();
    const { router, host } = await openApp(from, locale);
    await act(() => router.navigate(to));
    expect(document.title).toBe(`${page} - Shoutory`);
    const h1 = host.querySelector("h1");
    expect(h1?.textContent).toBe(page);
    expect(document.activeElement).toBe(h1);
  });

  it("a failed guard is a route change too: the system page is titled and focused", async () => {
    stubApi({ session: () => refusal("service_unavailable", 503) });
    const { router, host } = await openApp("/sign-in");
    await act(() => router.navigate("/"));
    expect(document.title).toBe("Shoutory is not reachable right now - Shoutory");
    expect(document.activeElement).toBe(host.querySelector("h1"));
  });

  it("the first load sets the title and moves no focus", async () => {
    stubApi();
    await openApp("/sign-in");
    expect(document.title).toBe("Sign in - Shoutory");
    expect(document.activeElement).toBe(document.body);
  });

  // A replace navigation is a redirect on the first load, not a page the user went to: no focus moves (R399 2).
  it.each([
    ["the start redirect", {}, "/", "/w/w1"],
    ["a guard redirect", { session: () => refusal("unauthenticated", 401) }, "/w/w1", "/sign-in"],
  ])("%s moves no focus", async (_name, api, from, lands) => {
    stubApi(api);
    const { router } = await openApp(from);
    expect(router.state.location.pathname).toBe(lands);
    expect(document.activeElement).toBe(document.body);
  });

  it("a change of the query alone moves no focus", async () => {
    stubApi();
    const { router, host } = await openApp("/sign-in");
    const link = host.querySelector("a");
    act(() => link?.focus());
    await act(() => router.navigate("/sign-in?return-to=%2Fcalendar"));
    expect(document.activeElement).toBe(link);
  });
});
