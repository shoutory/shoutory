import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  openAdmin,
  openApp,
  refusal,
  settle,
  stubApi,
} from "../../test/support/app";

afterEach(closeApp);

const NOT_ADMIN = { admin: () => json({ data: { admin: false } }) };
const FAILED = { admin: () => refusal("service_unavailable", 503) };
const adminCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url]) => url.includes("/api/v1/admin/"));

describe("the Admin entry and frame", () => {
  // A failed read is no answer: the rail simply has no entry, and the page shows no error of its own.
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
  ])("%s opening %s gets the not-found page and no admin call", async (_who, api, path) => {
    const stub = stubApi(api);
    const { host } = await openApp(path);
    expect(host.querySelector("h1")?.textContent).toBe("Page not found");
    expect(adminCalls(stub)).toHaveLength(0);
  });

  // No answer is not "no": a failed admin read or a failed shell list shows the error panel with Retry, which reads
  // the shell again, and still makes no admin call.
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
  it("says there are no provider apps in this build and reads nothing", async () => {
    const { host, stub } = await openAdmin("/admin/providers");
    expect(host.querySelector("h1")?.textContent).toBe("Provider apps");
    expect(host.querySelector('[data-kind="first-use"]')?.textContent).toMatch(
      /no provider apps in this build/i,
    );
    expect(adminCalls(stub)).toHaveLength(0);
  });
});
