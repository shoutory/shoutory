import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  DEVICES,
  json,
  openApp,
  refusal,
  stubApi,
  type,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/account/security";
const CURRENT = "current horse battery 7";
const NEXT = "another horse battery 9";
const CODES = ["aaaaa-11111", "bbbbb-22222", "ccccc-33333"];
const on = (left: number | null) => () => json({ data: { enabled: true, recovery_codes_left: left } });
const settle = () => act(async () => undefined);
const callsTo = (stub: ReturnType<typeof stubApi>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));
const bodyOf = (call: readonly [string, (RequestInit | undefined)?] | undefined) =>
  JSON.parse(String(call?.[1]?.body));
const field = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
function fill(host: ParentNode, name: string, value: string) {
  const input = field(host, name);
  if (!input) throw new Error(`the page has no input named "${name}"`);
  type(input, value);
}
const rows = (host: ParentNode) => [...host.querySelectorAll("tbody tr")];

describe("the account menu", () => {
  it("links to the security page", async () => {
    stubApi();
    const { host, router } = await openApp("/w/w1");
    click(byText(host, "button", "Account"));
    const link = byText<HTMLAnchorElement>(document.body, "a", "Security");
    expect(link.getAttribute("href")).toBe(PATH);
    click(link);
    await settle();
    expect(router.state.location.pathname).toBe(PATH);
  });
});

async function changePassword(api: Parameters<typeof stubApi>[0] = {}, next = NEXT) {
  const stub = stubApi(api);
  const opened = await openApp(PATH);
  fill(opened.host, "currentPassword", CURRENT);
  fill(opened.host, "newPassword", next);
  click(byText(opened.host, "button", "Change password"));
  await settle();
  return { ...opened, stub };
}

// NFR-SEC-28..30: the current password is checked first, then used once more with the new one; nothing is kept.
describe("changing the password (security floor)", () => {
  it("checks the current password, then changes it with only the two passwords, and keeps both out of URLs and storage", async () => {
    stubApi();
    const fields = await openApp(PATH);
    expect(field(fields.host, "currentPassword")?.getAttribute("autocomplete")).toBe("current-password");
    expect(field(fields.host, "newPassword")?.getAttribute("autocomplete")).toBe("new-password");
    expect([field(fields.host, "currentPassword")?.type, field(fields.host, "newPassword")?.type]).toEqual([
      "password",
      "password",
    ]);
    closeApp();
    const { stub, host, router } = await changePassword();
    const paths = stub.mock.calls
      .map(([path]) => path)
      .filter((path) => /verify-password|change-password/.test(path));
    expect(paths).toEqual(["/api/auth/verify-password", "/api/auth/change-password"]);
    expect(bodyOf(callsTo(stub, "verify-password")[0])).toEqual({ password: CURRENT });
    expect(bodyOf(callsTo(stub, "change-password")[0])).toEqual({
      currentPassword: CURRENT,
      newPassword: NEXT,
    });
    expect(stub.mock.calls.every(([path]) => !path.includes(CURRENT) && !path.includes(NEXT))).toBe(true);
    expect(JSON.stringify([{ ...localStorage }, { ...sessionStorage }, router.state.location])).not.toMatch(
      /horse battery/,
    );
    expect(host.innerHTML).not.toContain(CURRENT);
    expect(field(host, "currentPassword")?.value).toBe("");
    expect(field(host, "newPassword")?.value).toBe("");
  });

  it("a new password under 15 characters sends nothing", async () => {
    const { stub, host } = await changePassword({}, "too short pw 1");
    expect(callsTo(stub, "verify-password")).toHaveLength(0);
    expect(host.textContent).toMatch(/15 characters/);
  });
});

describe("the password change answers", () => {
  it("success says the other devices were signed out and that this one stays signed in", async () => {
    const { host, stub } = await changePassword();
    // The change ends the other sessions, so the device list is read again.
    expect(stub.mock.calls.filter(([path]) => path === "/api/auth/sessions")).toHaveLength(2);
    const statuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ");
    expect(statuses).toMatch(/other devices were signed out/i);
    expect(statuses).toMatch(/this device stays signed in/i);
  });

  it.each([
    ["a wrong current password", { verifyPassword: () => refusal("validation_failed", 400) }, /not right/i],
    [
      "a password found in a breach",
      {
        changePassword: () =>
          json({ error: { code: "validation_failed", details: { reason: "password_breached" } } }, 400),
      },
      /data breach/i,
    ],
    [
      "a new password the server refuses",
      { changePassword: () => refusal("validation_failed", 400) },
      /not accepted/i,
    ],
    ["too many attempts", { verifyPassword: () => refusal("too_many_requests", 429) }, /few minutes/i],
  ])("%s has its own words", async (_name, api, words) => {
    const { host } = await changePassword(api);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(words);
  });
});

describe("the signed-in devices", () => {
  it("lists them in the order given, the current one named and with no button, each user agent left to right", async () => {
    stubApi();
    const { host } = await openApp(PATH);
    const listed = rows(host);
    expect(listed).toHaveLength(DEVICES.length);
    expect(listed[0]?.textContent).toContain("This device");
    expect(listed[0]?.querySelector("button")).toBeNull();
    expect(listed.slice(1).every((row) => row.querySelector("button"))).toBe(true);
    const agent = [...host.querySelectorAll('[dir="ltr"]')].find((node) =>
      node.textContent?.includes("iPhone"),
    );
    expect(agent?.textContent).toBe("Mozilla/5.0 (iPhone) Safari/604.1");
    expect(rows(host)[2]?.textContent).toMatch(/unknown device/i);
    expect(host.querySelector("table")?.getAttribute("aria-label")).toBe("Signed-in devices");
    expect(host.querySelectorAll("thead th")).toHaveLength(3);
  });

  it("ending one device sends its id and removes its row", async () => {
    const stub = stubApi();
    const { host } = await openApp(PATH);
    click(byText(rows(host)[1] as HTMLElement, "button", "End session"));
    await settle();
    expect(bodyOf(callsTo(stub, "sessions/revoke")[0])).toEqual({ id: "s-phone" });
    expect(rows(host)).toHaveLength(DEVICES.length - 1);
    expect(document.activeElement?.textContent).toBe("Signed-in devices");
  });

  it("a failed end keeps the row and shows the error", async () => {
    stubApi({ revokeSession: () => refusal("service_unavailable", 503) });
    const { host } = await openApp(PATH);
    click(byText(rows(host)[1] as HTMLElement, "button", "End session"));
    await settle();
    expect(rows(host)).toHaveLength(DEVICES.length);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
  });

  it("signing out the other devices sends one empty POST and leaves only this device", async () => {
    const stub = stubApi();
    const { host } = await openApp(PATH);
    click(byText(host, "button", "Sign out other devices"));
    await settle();
    expect(callsTo(stub, "revoke-others")).toHaveLength(1);
    expect(rows(host)).toHaveLength(1);
    expect(() => byText(host, "button", "Sign out other devices")).toThrow();
    expect(document.activeElement?.textContent).toBe("Signed-in devices");
  });

  it("a failed list shows the error panel and the other blocks stay", async () => {
    stubApi({ sessions: () => refusal("service_unavailable", 503) });
    const { host } = await openApp(PATH);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
    expect(field(host, "currentPassword")).not.toBeNull();
  });
});

describe("the two-step verification block", () => {
  it("off offers the setup and no recovery codes", async () => {
    stubApi();
    const { host } = await openApp(PATH);
    expect(byText<HTMLAnchorElement>(host, "a", "Set up").getAttribute("href")).toBe(
      "/account/security/two-factor",
    );
    expect(() => byText(host, "button", "New recovery codes")).toThrow();
  });

  it("on shows the codes left and offers new codes, not the setup", async () => {
    stubApi({ twoFactorStatus: on(7) });
    const { host } = await openApp(PATH);
    expect(host.textContent).toContain("Recovery codes remaining: 7");
    expect(byText(host, "button", "New recovery codes")).toBeDefined();
    expect(() => byText(host, "a", "Set up")).toThrow();
  });

  it("no codes left shows the warning", async () => {
    stubApi({ twoFactorStatus: on(0) });
    const { host } = await openApp(PATH);
    expect(host.textContent).toMatch(/no recovery codes left/i);
  });
});

// F-TEAM-006, NFR-SEC-17: new codes are shown once, after the password was checked, and kept nowhere.
describe("new recovery codes (security floor)", () => {
  async function regenerate() {
    const stub = stubApi({
      twoFactorStatus: on(7),
      generateCodes: () => json({ status: true, backupCodes: CODES }),
    });
    const opened = await openApp(PATH);
    click(byText(opened.host, "button", "New recovery codes"));
    expect(document.activeElement).toBe(field(opened.host, "password"));
    fill(opened.host, "password", CURRENT);
    click(byText(opened.host, "button", "Generate codes"));
    await settle();
    return { ...opened, stub };
  }

  it("checks the password, then asks for codes with it; they show once and are in no URL, storage or state", async () => {
    const { stub, host, router } = await regenerate();
    const paths = stub.mock.calls
      .map(([path]) => path)
      .filter((path) => /verify-password|generate-backup/.test(path));
    expect(paths).toEqual(["/api/auth/verify-password", "/api/auth/two-factor/generate-backup-codes"]);
    expect(bodyOf(callsTo(stub, "generate-backup-codes")[0])).toEqual({ password: CURRENT });
    expect(CODES.filter((code) => host.innerHTML.includes(code))).toEqual(CODES);
    const surfaces = JSON.stringify([
      { ...localStorage },
      { ...sessionStorage },
      location.href,
      history.state,
      router.state.location,
      stub.mock.calls.map(([path]) => path),
    ]);
    expect(CODES.filter((code) => surfaces.includes(code))).toEqual([]);
    expect(host.innerHTML).not.toContain(CURRENT);
  });

  it("saving them removes them from the page and reads the count again", async () => {
    const { stub, host } = await regenerate();
    const reads = callsTo(stub, "two-factor/status").length;
    click(byText(host, "button", "I saved my codes"));
    await settle();
    expect(CODES.filter((code) => host.innerHTML.includes(code))).toEqual([]);
    expect(callsTo(stub, "two-factor/status").length).toBe(reads + 1);
    expect(document.activeElement?.textContent).toBe("Two-step verification");
  });
});
