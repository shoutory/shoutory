import { afterEach, describe, expect, it, vi } from "vitest";
import {
  byText,
  callsTo,
  click,
  closeApp,
  confirmPassword,
  FLAGS,
  json,
  needsPassword,
  openAdmin,
  optionTexts,
  pick,
  press,
  refusal,
  rowOf,
  selectTrigger,
  settle,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/admin/flags";
const OVERRIDE = "/flags/new-composer/override";
const row = (host: HTMLElement, key = "new-composer") => rowOf(host, key);
const ok = () => json({ data: { key: "new-composer", on: true } });

describe("the feature flags screen", () => {
  it("lists each flag with its owner, removal date in UTC and state, and marks the expired one", async () => {
    const { host } = await openAdmin(PATH);
    expect(host.querySelector("h1")?.textContent).toBe("Feature flags");
    expect(row(host).textContent).toContain("core-team");
    expect(row(host).textContent).toContain("2099-01-01 (UTC)");
    expect(row(host, "dark-launch").textContent).toMatch(/off/i);
    expect(row(host, "old-thing").getAttribute("data-expired")).toBe("true");
    expect(row(host, "old-thing").textContent).toMatch(/expired/i);
    expect(row(host).getAttribute("data-expired")).toBeNull();
  });

  it.each([
    ["2026-11-19T23:30:00Z", false],
    ["2026-11-20T00:30:00Z", true],
  ])("at %s a flag removed on 2026-11-19 is expired: %s", async (now, expired) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    const edge = { ...FLAGS[0], key: "edge-flag", remove_by: "2026-11-19" };
    const { host } = await openAdmin(PATH, { adminFlags: () => json({ data: [edge] }) });
    expect(row(host, "edge-flag").getAttribute("data-expired") === "true").toBe(expired);
  });

  it("a failed read shows the error panel with Retry and keeps the admin frame", async () => {
    const { host } = await openAdmin(PATH, { adminFlags: () => refusal("service_unavailable", 503) });
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Admin sections"]')).not.toBeNull();
  });

  it.each([
    ["new-composer", ["On", "Off", "Default (off)"]],
    ["dark-launch", ["On", "Off", "Default (on)"]],
  ])("the override of %s offers on, off and a default that names its state", async (key, options) => {
    const { host } = await openAdmin(PATH);
    click(selectTrigger(row(host, key), "Override"));
    expect(optionTexts()).toEqual(options);
  });
});

describe("overriding a flag", () => {
  it.each([
    ["new-composer", "On", true],
    ["new-composer", "Off", false],
    ["dark-launch", "Default (on)", null],
  ])(
    "on %s, choosing %s sends {on: %s} after one password check and replays once",
    async (key, option, on) => {
      const { host, stub } = await openAdmin(PATH, needsPassword("overrideFlag", ok));
      pick(row(host, key), "Override", option);
      await settle();
      await confirmPassword();
      const puts = callsTo(stub, "PUT", `/flags/${key}/override`);
      expect(puts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ on }, { on }]);
      expect(callsTo(stub, "POST", "/api/auth/verify-password")).toHaveLength(1);
      expect(callsTo(stub, "GET", "/api/v1/admin/flags")).toHaveLength(2);
    },
  );

  it("a cancelled password check changes nothing and says so", async () => {
    const { host, stub } = await openAdmin(PATH, { overrideFlag: () => refusal("step_up_required", 403) });
    pick(row(host), "Override", "On");
    await settle();
    click(byText(document.body, '[role="dialog"] button', "Cancel"));
    await settle();
    expect(callsTo(stub, "PUT", OVERRIDE)).toHaveLength(1);
    expect(host.textContent).toMatch(/nothing was changed/i);
    expect(callsTo(stub, "GET", "/api/v1/admin/flags")).toHaveLength(1);
  });

  it("a 404 keeps the page, shows the error panel and does not read the list as changed", async () => {
    const { host } = await openAdmin(PATH, { overrideFlag: () => refusal("not_found", 404) });
    pick(row(host), "Override", "On");
    await settle();
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(row(host)).toBeDefined();
  });
});

describe("a flag's override list while it cannot be used", () => {
  it("is unavailable while its call runs", async () => {
    const { host } = await openAdmin(PATH, { overrideFlag: () => new Promise<Response>(() => undefined) });
    pick(row(host), "Override", "On");
    await settle();
    const trigger = selectTrigger(row(host), "Override");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    click(trigger);
    expect(optionTexts()).toEqual([]);
  });

  // A closed React Aria list selects on ArrowLeft and ArrowRight: while unavailable that must change nothing.
  it.each([
    ["an expired flag", "old-thing", 0],
    ["a pending change", "new-composer", 1],
  ])(
    "%s ignores the arrow keys on its closed trigger: no call, no password prompt",
    async (_what, key, calls) => {
      const { host, stub } = await openAdmin(PATH, {
        overrideFlag: () => new Promise<Response>(() => undefined),
      });
      if (calls > 0) {
        pick(row(host, key), "Override", "On");
        await settle();
      }
      for (const arrow of ["ArrowLeft", "ArrowRight"])
        press(selectTrigger(row(host, key), "Override"), arrow);
      await settle();
      expect(callsTo(stub, "PUT", "/override")).toHaveLength(calls);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("an expired flag's list is unavailable with its reason and sends nothing", async () => {
    const { host, stub } = await openAdmin(PATH);
    const old = row(host, "old-thing");
    const trigger = selectTrigger(old, "Override");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(old.textContent).toMatch(/past its removal date/i);
    click(trigger);
    expect(optionTexts()).toEqual([]);
    expect(callsTo(stub, "PUT", "/override")).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
