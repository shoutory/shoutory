import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { byText, click, closeApp, json, openApp, refusal, stubApi, type } from "../../test/support/app";
import { detectLocale, storedLocale } from "../i18n/i18n";

afterEach(() => {
  closeApp();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

const settle = () => act(async () => undefined);
const callsTo = (stub: ReturnType<typeof stubApi>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));
const nameField = (host: ParentNode) => host.querySelector<HTMLInputElement>('input[name="name"]');
const radio = (host: ParentNode, label: string) =>
  byText<HTMLElement>(host, "label", label).querySelector<HTMLInputElement>('input[type="radio"]');
function choose(host: ParentNode, label: string) {
  const input = radio(host, label);
  if (!input) throw new Error(`no radio named "${label}"`);
  click(input);
}
async function save(host: ParentNode, name: string) {
  const field = nameField(host);
  if (!field) throw new Error("the page has no name field");
  type(field, name);
  click(byText(host, "button", "Save"));
  await settle();
}

describe("the account menu", () => {
  it("links to the profile page", async () => {
    stubApi();
    const { host, router } = await openApp("/w/w1");
    click(byText(host, "button", "Account"));
    const link = byText<HTMLAnchorElement>(document.body, "a", "Profile");
    expect(link.getAttribute("href")).toBe("/account/profile");
    click(link);
    await settle();
    expect(router.state.location.pathname).toBe("/account/profile");
  });
});

describe("the profile name", () => {
  it("starts with the name of the session, saves it with one POST of only the name, and reloads the session", async () => {
    const stub = stubApi();
    const { host } = await openApp("/account/profile");
    expect(nameField(host)?.value).toBe("Person Sample");
    expect(nameField(host)?.getAttribute("autocomplete")).toBe("name");
    const sessionReads = callsTo(stub, "get-session").length;
    await save(host, "New Name");
    const [, init] = callsTo(stub, "/api/auth/profile")[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "New Name" });
    expect(callsTo(stub, "get-session").length).toBe(sessionReads + 1);
    const statuses = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    expect(statuses.join(" ")).toMatch(/saved/i);
  });

  it.each([
    ["an empty name", ""],
    ["a name of 101 characters", "n".repeat(101)],
  ])("%s sends nothing and says why", async (_name, value) => {
    const stub = stubApi();
    const { host } = await openApp("/account/profile");
    await save(host, value);
    expect(callsTo(stub, "/api/auth/profile")).toHaveLength(0);
    expect(host.textContent).toMatch(/1 to 100 characters/);
  });

  it("a server failure keeps what was typed and shows the error panel", async () => {
    stubApi({ profile: () => refusal("service_unavailable", 503) });
    const { host } = await openApp("/account/profile");
    await save(host, "Kept Name");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(nameField(host)?.value).toBe("Kept Name");
  });
});

// The three settings stay in this browser (no migration yet): each applies at once and is read back at start-up.
describe("the profile language, theme and digits", () => {
  it("the language applies at once and is the one the next start reads", async () => {
    stubApi();
    const { host } = await openApp("/account/profile");
    choose(host, "العربية");
    await settle();
    expect([document.documentElement.lang, document.documentElement.dir]).toEqual(["ar", "rtl"]);
    // The words follow when the catalog has loaded.
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("الملف الشخصي"));
    expect(storedLocale()).toBe("ar");
    expect(detectLocale(storedLocale(), ["en"])).toBe("ar");
  });

  it.each([
    ["Dark", "dark"],
    ["Light", "light"],
  ])("the theme %s applies at once and is the one the next start reads", async (label, value) => {
    stubApi();
    const { host } = await openApp("/account/profile");
    choose(host, label);
    await settle();
    expect(document.documentElement.dataset.theme).toBe(value);
    expect(localStorage.getItem("shoutory.theme")).toBe(value);
    // A reload keeps the browser's storage; the harness's cleanup empties it, so it is put back.
    closeApp();
    localStorage.setItem("shoutory.theme", value);
    stubApi();
    const again = await openApp("/account/profile");
    expect(radio(again.host, label)?.checked).toBe(true);
  });

  it("Arabic-Indic digits apply to the sample number at once and are remembered", async () => {
    stubApi();
    const { host } = await openApp("/account/profile");
    expect(host.textContent).toContain("1,234");
    choose(host, "Arabic-Indic");
    await settle();
    expect(host.textContent).toContain("١٬٢٣٤");
    expect(localStorage.getItem("shoutory.digits")).toBe("arab");
  });
});

describe("the profile page when the session ends", () => {
  it("a 401 while saving sends the visitor to sign in", async () => {
    stubApi({ profile: () => json({ error: { code: "unauthenticated", message: "m" } }, 401) });
    const { host, router } = await openApp("/account/profile");
    await save(host, "Any Name");
    expect(router.state.location.pathname).toBe("/sign-in");
  });
});
