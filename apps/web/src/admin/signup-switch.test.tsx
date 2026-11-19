import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  callsTo,
  click,
  closeApp,
  confirmPassword,
  json,
  needsPassword,
  openAdmin,
  refusal,
  settle,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/admin/signup";
const PUT = "/admin/settings/signup_enabled";
const ok = () => json({ data: { key: "signup_enabled", value: true } });
const settings = (rows: unknown[]) => ({ adminSettings: () => json({ data: rows }) });
const toggle = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[role="switch"]');

describe("the sign-up switch", () => {
  // The setting row is absent until an admin writes it, and absent means off.
  it.each([
    ["no row", false, []],
    ["true", true, [{ key: "signup_enabled", value: true }]],
    ["false", false, [{ key: "signup_enabled", value: false }]],
  ])("reads %s as switched on: %s", async (_what, on, rows) => {
    const { host } = await openAdmin(PATH, settings(rows));
    expect(host.querySelector("h1")?.textContent).toBe("Sign-up");
    expect(toggle(host)?.checked).toBe(on);
  });

  it.each([
    ["off", /only invited addresses can sign up/i, []],
    ["on", /anyone can sign up/i, [{ key: "signup_enabled", value: true }]],
  ])("states its effect while %s, and the two exceptions", async (_state, effect, rows) => {
    const { host } = await openAdmin(PATH, settings(rows));
    expect(host.textContent).toMatch(effect);
    expect(host.textContent).toMatch(/first sign-up on an empty instance is always open/i);
    expect(host.textContent).toMatch(/invited address may still sign up/i);
  });

  it("a failed read shows the error panel with Retry and keeps the admin frame", async () => {
    const { host } = await openAdmin(PATH, { adminSettings: () => refusal("service_unavailable", 503) });
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector('nav[aria-label="Admin sections"]')).not.toBeNull();
  });
});

describe("changing the sign-up switch", () => {
  it("writes {value} after one password check, shows the new state only after the answer", async () => {
    const { host, stub } = await openAdmin(PATH, needsPassword("setSignup", ok));
    click(toggle(host) as HTMLElement);
    await settle();
    expect(toggle(host)?.checked).toBe(false);
    await confirmPassword();
    const puts = callsTo(stub, "PUT", PUT).map(([, init]) => JSON.parse(String(init?.body)));
    expect(puts).toEqual([{ value: true }, { value: true }]);
    expect(callsTo(stub, "POST", "/api/auth/verify-password")).toHaveLength(1);
    expect(toggle(host)?.checked).toBe(true);
  });

  it("a cancelled password check changes nothing and says so", async () => {
    const { host } = await openAdmin(PATH, { setSignup: () => refusal("step_up_required", 403) });
    click(toggle(host) as HTMLElement);
    await settle();
    click(byText(document.body, '[role="dialog"] button', "Cancel"));
    await settle();
    expect(toggle(host)?.checked).toBe(false);
    expect(host.textContent).toMatch(/nothing was changed/i);
  });

  it("is busy while its call runs and ignores a second change", async () => {
    const { host, stub } = await openAdmin(PATH, { setSignup: () => new Promise<Response>(() => undefined) });
    click(toggle(host) as HTMLElement);
    await settle();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(toggle(host)?.disabled).toBe(false);
    click(toggle(host) as HTMLElement);
    await settle();
    expect(callsTo(stub, "PUT", PUT)).toHaveLength(1);
  });

  it("a refused write keeps the old state and shows the error panel", async () => {
    const { host } = await openAdmin(PATH, { setSignup: () => refusal("not_found", 404) });
    click(toggle(host) as HTMLElement);
    await settle();
    expect(toggle(host)?.checked).toBe(false);
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
  });
});
