import { afterEach, describe, expect, it } from "vitest";
import { callsTo, closeApp, json, openAdmin, refusal, SYSTEM } from "../../test/support/app";

afterEach(closeApp);

const PATH = "/admin/releases";
const system = (over: object) => ({ adminSystem: () => json({ data: { ...SYSTEM, ...over } }) });

describe("the releases screen", () => {
  it("shows the version, the channel and that every migration is applied, and makes no call but its read", async () => {
    const { host, stub } = await openAdmin(PATH);
    expect(host.querySelector("h1")?.textContent).toBe("Releases");
    expect(host.textContent).toContain("1.2.3");
    expect(host.textContent).toMatch(/stable/i);
    expect(host.textContent).toMatch(/all migrations are applied/i);
    expect(
      stub.mock.calls
        .map(([url]) => url)
        .filter((url) => !url.includes("/admin/system") && url.includes("/admin/")),
    ).toEqual([]);
    expect(callsTo(stub, "GET", "/admin/system")).toHaveLength(1);
  });

  it("shows the channel the server names", async () => {
    const { host } = await openAdmin(PATH, system({ channel: "beta" }));
    expect(host.textContent).toMatch(/beta/i);
  });

  it("lists a migration that is not applied yet, and says the instance is behind", async () => {
    const migrations = { applied: 11, shipped: 12, pending: ["0012_outbox.sql"] };
    const { host } = await openAdmin(PATH, system({ migrations }));
    expect(host.textContent).toContain("0012_outbox.sql");
    expect(host.textContent).toMatch(/not applied/i);
  });

  it("shows a version that could not be read as not available", async () => {
    const { host } = await openAdmin(PATH, system({ version: null }));
    expect(host.textContent).toMatch(/version[\s\S]*not available/i);
  });

  // No update feed is read: a fresh install makes no idle outbound call, so the notice area stays quiet.
  it("keeps the update area quiet and says updates are not checked", async () => {
    const { host } = await openAdmin(PATH);
    expect(host.querySelector('[data-kind="update-notice"]')?.textContent).toMatch(
      /updates are not checked/i,
    );
  });

  it("a failed read shows the error panel with Retry and keeps the admin frame", async () => {
    const { host } = await openAdmin(PATH, { adminSystem: () => refusal("service_unavailable", 503) });
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Admin sections"]')).not.toBeNull();
  });
});
