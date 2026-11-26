import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  byText,
  click,
  closeApp,
  combobox,
  json,
  openApp,
  refusal,
  SESSION,
  stubApi,
  type,
} from "../../test/support/app";
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

const AT = "2026-11-20T08:00:00.000Z";
const withPicture = () => json({ data: { ...SESSION.data, user: { ...SESSION.data.user, avatarAt: AT } } });
const picture = (host: ParentNode) => host.querySelector<HTMLElement>('[data-testid="profile-picture"]');
const fileInput = (host: ParentNode) => {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("the page has no file input");
  return input;
};
async function pickFile(host: ParentNode, file: File) {
  const input = fileInput(host);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
const pictureStatus = (host: ParentNode) =>
  picture(host)?.closest("section")?.querySelector('[role="status"]')?.textContent;
const image = (type = "image/png", size = 2048) => new File([new Uint8Array(size)], "me.png", { type });

describe("choosing a profile picture", () => {
  it("offers only the accepted types, sends the chosen file in one PUT and reloads the session", async () => {
    const stub = stubApi();
    const { host } = await openApp("/account/profile");
    expect(fileInput(host).accept).toBe("image/jpeg,image/png,image/webp");
    expect(picture(host)?.textContent).toBe("P");
    const sessionReads = callsTo(stub, "get-session").length;
    const file = image();
    await pickFile(host, file);
    const puts = callsTo(stub, "/api/v1/me/avatar").filter(([, init]) => init?.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.[1]?.body).toBe(file);
    expect(callsTo(stub, "get-session").length).toBe(sessionReads + 1);
    expect(pictureStatus(host)).toBe("Picture saved");
  });

  it.each([
    ["a file over 10 MB", image("image/png", 10 * 1024 * 1024 + 1), /too large/],
    ["a file that is not an image", image("application/pdf"), /cannot be used as a picture/],
  ])("%s sends nothing and says why", async (_name, file, said) => {
    const stub = stubApi();
    const { host } = await openApp("/account/profile");
    await pickFile(host, file);
    expect(callsTo(stub, "/api/v1/me/avatar")).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(said);
  });

  it.each([
    ["a too large answer", refusal("payload_too_large", 413), /too large/],
    ["an unreadable image", refusal("unprocessable_content", 422, { reason: "corrupt" }), /cannot be used/],
    [
      "an image of too many pixels",
      refusal("unprocessable_content", 422, { reason: "pixel_limit" }),
      /too big to read/,
    ],
  ])("%s from the server is named and the picture is kept", async (_name, answer, said) => {
    stubApi({ putPicture: () => answer });
    const { host } = await openApp("/account/profile");
    await pickFile(host, image());
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(said);
    expect(picture(host)?.textContent).toBe("P");
  });
});

describe("the profile picture while offline or saving", () => {
  it("offline, the choose button says why and a picked file is not sent", async () => {
    const stub = stubApi();
    const { host } = await openApp("/account/profile");
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    const button = host.querySelector('[data-testid="picture-choose"]');
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain("You are offline. This needs the server.");
    await pickFile(host, image());
    expect(callsTo(stub, "/api/v1/me/avatar")).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Nothing was sent/);
    vi.unstubAllGlobals();
  });

  it("the choose button is busy and unavailable while the picture is saving, and a second pick is not sent", async () => {
    let answer: (response: Response) => void = () => undefined;
    const stub = stubApi({ putPicture: () => new Promise<Response>((resolve) => (answer = resolve)) });
    const { host } = await openApp("/account/profile");
    await pickFile(host, image());
    const button = host.querySelector('[data-testid="picture-choose"]');
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    await pickFile(host, image());
    expect(callsTo(stub, "/api/v1/me/avatar")).toHaveLength(1);
    await act(async () => answer(json({ data: { avatar_at: AT } })));
  });
});

describe("a saved profile picture", () => {
  it("shows the saved picture by its change time, and Remove sends one DELETE", async () => {
    const stub = stubApi({ session: withPicture });
    const { host } = await openApp("/account/profile");
    const img = picture(host)?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`/api/v1/me/avatar?v=${encodeURIComponent(AT)}`);
    click(byText(host, "button", "Remove picture"));
    await settle();
    const deletes = callsTo(stub, "/api/v1/me/avatar").filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  it("after Remove the focus moves to Choose picture and the removal is announced", async () => {
    let removed = false;
    stubApi({
      session: () => (removed ? json(SESSION) : withPicture()),
      deletePicture: () => {
        removed = true;
        return new Response(null, { status: 204 });
      },
    });
    const { host } = await openApp("/account/profile");
    click(byText(host, "button", "Remove picture"));
    await settle();
    expect(host.querySelector('[data-testid="picture-remove"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("picture-choose");
    expect(pictureStatus(host)).toBe("Picture removed");
  });

  it("a picture that cannot be shown falls back to the first letter", async () => {
    stubApi({ session: withPicture });
    const { host } = await openApp("/account/profile");
    const img = picture(host)?.querySelector("img");
    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(picture(host)?.querySelector("img")).toBeNull();
    expect(picture(host)?.textContent).toBe("P");
  });
});

describe("the profile language, theme and digits", () => {
  it("the language applies at once and is the one the next start reads", async () => {
    stubApi();
    const { host } = await openApp("/account/profile");
    choose(host, "العربية");
    await settle();
    expect([document.documentElement.lang, document.documentElement.dir]).toEqual(["ar", "rtl"]);
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

describe("the profile time zone", () => {
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
  const zoneInput = (host: ParentNode, label: string) => combobox(host, label);

  // The browser's zone is fixed, so a typed city is never the zone already selected (the host's own zone may be it).
  beforeEach(() => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
    } as Intl.ResolvedDateTimeFormatOptions);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["en", "Time zone", "Cairo", "Cairo (UTC+2)", /summer/i],
    ["ar", "المنطقة الزمنية", "القاهرة", "القاهرة (UTC+2)", /الصيف/],
  ] as const)(
    "the %s picker finds Cairo by its name, with offset and note, never a raw id",
    async (locale, label, query, shown, note) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
      stubApi();
      const { host } = await openApp("/account/profile", locale);
      type(zoneInput(host, label), query);
      const found = options().find((text) => text.includes(shown));
      expect(found).toMatch(note);
      expect(document.body.textContent).not.toContain("Africa/Cairo");
    },
  );

  it("a zone with no clock change shows no note", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    stubApi();
    const { host } = await openApp("/account/profile");
    type(zoneInput(host, "Time zone"), "Riyadh");
    expect(options().filter((text) => text.startsWith("Riyadh"))).toEqual(["Riyadh (UTC+3)"]);
  });
});

describe("the profile time zone choice", () => {
  const zoneInput = (host: ParentNode, label: string) => combobox(host, label);
  afterEach(() => vi.restoreAllMocks());

  it("starts with the browser's zone, and a pick is stored and shown again after a reload", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Tokyo",
    } as Intl.ResolvedDateTimeFormatOptions);
    stubApi();
    const first = await openApp("/account/profile");
    expect(zoneInput(first.host, "Time zone").value).toBe("Tokyo");
    type(zoneInput(first.host, "Time zone"), "Cairo");
    click(byText(document.body, '[role="option"]', "Cairo"));
    expect(localStorage.getItem("shoutory.zone")).toBe("Africa/Cairo");
    // A reload keeps the browser's storage; the harness's cleanup empties it, so it is put back.
    closeApp();
    localStorage.setItem("shoutory.zone", "Africa/Cairo");
    stubApi();
    const again = await openApp("/account/profile");
    expect(zoneInput(again.host, "Time zone").value).toBe("Cairo");
  });
});
