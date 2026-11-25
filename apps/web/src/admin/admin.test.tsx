import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_PROVIDERS,
  byText,
  click,
  closeApp,
  json,
  openAdmin,
  openApp,
  refusal,
  rowOf,
  settle,
  stubApi,
} from "../../test/support/app";

afterEach(closeApp);

const NOT_ADMIN = { admin: () => json({ data: { admin: false } }) };
const FAILED = { admin: () => refusal("service_unavailable", 503) };
const adminCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url]) => url.includes("/api/v1/admin/"));

describe("the Admin entry and frame", () => {
  it.each([
    ["a non-admin", NOT_ADMIN],
    ["a failed admin read", FAILED],
  ])("%s sees no Admin entry and no error page", async (_who, api) => {
    stubApi(api);
    const { host } = await openApp("/w/w1");
    expect(host.querySelector('nav a[href="/admin"]')).toBeNull();
    expect(host.querySelector("nav")).not.toBeNull();
    expect(host.querySelector('main [role="alert"]')).toBeNull();
  });

  it.each([
    ["a non-admin", NOT_ADMIN, "/admin"],
    ["a non-admin", NOT_ADMIN, "/admin/flags"],
    ["a non-admin", NOT_ADMIN, "/admin/providers"],
  ])("%s opening %s gets the not-found page and no admin call", async (_who, api, path) => {
    const stub = stubApi(api);
    const { host } = await openApp(path);
    expect(host.querySelector("h1")?.textContent).toBe("Page not found");
    expect(adminCalls(stub)).toHaveLength(0);
  });

  it.each([
    ["a failed admin read", FAILED],
    ["a failed workspace list", { workspaces: () => refusal("service_unavailable", 503) }],
  ])("%s opening /admin/flags shows the error panel and Retry reads the shell again", async (_who, api) => {
    const stub = stubApi(api);
    const { host } = await openApp("/admin/flags");
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).not.toBe("Page not found");
    const before = stub.mock.calls.filter(([url]) => url.includes("/api/v1/instance/admin")).length;
    click(byText(host.querySelector("main") as HTMLElement, "button", "Retry"));
    await settle();
    const after = stub.mock.calls.filter(([url]) => url.includes("/api/v1/instance/admin")).length;
    expect(after).toBeGreaterThan(before);
    expect(adminCalls(stub)).toHaveLength(0);
  });

  it("an instance admin sees the entry, /admin lands on the flags, and the nav lists the six screens", async () => {
    const { host, router } = await openAdmin("/admin");
    expect(host.querySelector('nav a[href="/admin"]')?.textContent).toBe("Admin");
    expect(router.state.location.pathname).toBe("/admin/flags");
    const links = [...host.querySelectorAll('nav[aria-label="Admin sections"] a')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/admin/flags",
      "/admin/signup",
      "/admin/queue",
      "/admin/system",
      "/admin/releases",
      "/admin/providers",
    ]);
  });
});

describe("the provider apps screen", () => {
  it("lists each provider with the redirect URI to register, or says an instance provider registers itself, and changes nothing", async () => {
    const { host, stub } = await openAdmin("/admin/providers");
    expect(host.querySelector("h1")?.textContent).toBe("Provider apps");
    const fixed = rowOf(host, "Fixture Network");
    expect(fixed.textContent).toContain(ADMIN_PROVIDERS[0]?.redirect_uri);
    expect(fixed.querySelector('[dir="ltr"]')?.textContent).toBe(ADMIN_PROVIDERS[0]?.redirect_uri);
    expect(rowOf(host, "Instance Network").textContent).toMatch(/registers itself on each server/i);
    expect(host.querySelector("main button, main input")).toBeNull();
    expect(adminCalls(stub).map(([url]) => url)).toEqual(["/api/v1/admin/providers"]);
  });

  it("says there are no providers in this build when the list is empty", async () => {
    const { host } = await openAdmin("/admin/providers", { adminProviders: () => json({ data: [] }) });
    expect(host.querySelector('[data-kind="first-use"]')?.textContent).toMatch(/no providers in this build/i);
  });

  it("a failed read shows the error panel with Retry, which reads again", async () => {
    let failing = true;
    const { host, stub } = await openAdmin("/admin/providers", {
      adminProviders: () => (failing ? refusal("service_unavailable", 503) : json({ data: ADMIN_PROVIDERS })),
    });
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    failing = false;
    click(byText(host.querySelector("main") as HTMLElement, "button", "Retry"));
    await settle();
    expect(rowOf(host, "Fixture Network")).not.toBeNull();
    expect(adminCalls(stub)).toHaveLength(2);
  });
});
