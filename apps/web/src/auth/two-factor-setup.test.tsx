import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { byText, click, closeApp, json, openApp, refusal, stubApi, type } from "../../test/support/app";

const PATH = "/account/security/two-factor";
const PASSWORD = "correct horse battery 7";
const SECRET = "setupsecretabc234";
const URI = `otpauth://totp/Shoutory:person%40example.test?secret=${SECRET}&issuer=Shoutory`;
const CODES = ["aaaaa-11111", "bbbbb-22222", "ccccc-33333"];
const ENABLED = () => json({ method: "totp", totpURI: URI, backupCodes: CODES });
const SECRETS = [SECRET, URI, encodeURIComponent(URI), ...CODES];

const writeText = vi.fn((_text: string) => Promise.resolve());
const createObjectURL = vi.fn((_blob: Blob) => "blob:setup-codes-1");
const revokeObjectURL = vi.fn((_url: string) => undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  closeApp();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  vi.clearAllMocks();
});

const settle = () => act(async () => undefined);
const field = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
function fill(host: ParentNode, name: string, value: string) {
  const input = field(host, name);
  if (!input) throw new Error(`the page has no input named "${name}"`);
  type(input, value);
}
const callsTo = (stub: ReturnType<typeof stubApi>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));

async function toQr(api: Parameters<typeof stubApi>[0] = {}) {
  const stub = stubApi({ enable: ENABLED, ...api });
  const opened = await openApp(PATH);
  fill(opened.host, "password", PASSWORD);
  click(byText(opened.host, "button", "Continue"));
  await settle();
  return { ...opened, stub };
}
async function toCodes(api: Parameters<typeof stubApi>[0] = {}) {
  const opened = await toQr(api);
  fill(opened.host, "code", "123456");
  click(byText(opened.host, "button", "Turn on"));
  await settle();
  return opened;
}
const found = (host: HTMLElement, secrets = SECRETS) =>
  secrets.filter((secret) => host.innerHTML.includes(secret));

describe("the two-factor setup (security floor)", () => {
  it("the password field and the code field say what they are", async () => {
    stubApi({ enable: ENABLED });
    const { host } = await openApp(PATH);
    const password = field(host, "password");
    expect([password?.type, password?.getAttribute("autocomplete")]).toEqual([
      "password",
      "current-password",
    ]);
    fill(host, "password", PASSWORD);
    click(byText(host, "button", "Continue"));
    await settle();
    const code = field(host, "code");
    expect([code?.getAttribute("autocomplete"), code?.inputMode]).toEqual(["one-time-code", "numeric"]);
  });

  it("the password is checked, then setup starts; each call sends only the password", async () => {
    const { stub } = await toQr();
    const paths = stub.mock.calls.map(([path]) => path).filter((path) => path.includes("/api/auth/"));
    expect(paths.filter((path) => !path.includes("get-session"))).toEqual([
      "/api/auth/verify-password",
      "/api/auth/two-factor/enable",
    ]);
    for (const name of ["verify-password", "two-factor/enable"]) {
      const [, init] = callsTo(stub, name)[0] ?? [];
      expect(JSON.parse(String(init?.body))).toEqual({ password: PASSWORD });
    }
  });

  it("the secret, the address and the codes are in no storage, URL, request URL, history state or router state at any step", async () => {
    const { host, router, stub } = await toQr();
    const surfaces = () =>
      JSON.stringify([
        { ...localStorage },
        { ...sessionStorage },
        location.href,
        history.state,
        router.state.location,
        stub.mock.calls.map(([path]) => path),
      ]);
    expect(SECRETS.filter((secret) => surfaces().includes(secret))).toEqual([]);
    fill(host, "code", "123456");
    click(byText(host, "button", "Turn on"));
    await settle();
    expect(SECRETS.filter((secret) => surfaces().includes(secret))).toEqual([]);
    click(byText(host, "button", "I saved my codes"));
    await settle();
    expect(SECRETS.filter((secret) => surfaces().includes(secret))).toEqual([]);
  });
});

describe("the two-factor setup (security floor, the page and its leaving)", () => {
  it("the secret shows as text beside a QR drawn on the page; the address that holds it is never printed", async () => {
    const { host, stub } = await toQr();
    expect(host.textContent).toContain(SECRET);
    expect(host.querySelector("svg path")).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("otpauth");
    expect(stub.mock.calls.every(([path]) => path.startsWith("/api/"))).toBe(true);
  });

  it("the password is gone from the page after a refusal and after each step", async () => {
    stubApi({ verifyPassword: () => refusal("validation_failed", 400) });
    const { host } = await openApp(PATH);
    fill(host, "password", PASSWORD);
    click(byText(host, "button", "Continue"));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not right/i);
    expect(field(host, "password")?.value).toBe("");
    closeApp();
    const qr = await toQr();
    expect(qr.host.innerHTML).not.toContain(PASSWORD);
    fill(qr.host, "code", "123456");
    click(byText(qr.host, "button", "Turn on"));
    await settle();
    expect(qr.host.innerHTML).not.toContain(PASSWORD);
  });

  it("leaving the page drops the secret and the codes: coming back asks for the password again", async () => {
    const { host, router } = await toQr();
    await act(async () => void (await router.navigate("/")));
    await act(async () => void (await router.navigate(PATH)));
    expect(found(host)).toEqual([]);
    expect(field(host, "password")).not.toBeNull();
    fill(host, "password", PASSWORD);
    click(byText(host, "button", "Continue"));
    await settle();
    fill(host, "code", "123456");
    click(byText(host, "button", "Turn on"));
    await settle();
    await act(async () => void (await router.navigate("/")));
    expect(found(host)).toEqual([]);
  });
});

describe("the two-factor setup (security floor, the download)", () => {
  it("the download is one Blob of the codes whose URL is kept for the click, then revoked on a timer or on leaving", async () => {
    vi.useFakeTimers();
    createObjectURL.mockReturnValueOnce("blob:setup-codes-1").mockReturnValueOnce("blob:setup-codes-2");
    const { host, router } = await toCodes();
    click(byText(host, "button", "Download"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(await createObjectURL.mock.calls[0]?.[0].text()).toBe(CODES.join("\n"));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(40_000));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:setup-codes-1");
    click(byText(host, "button", "Download"));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => void (await router.navigate("/")));
    expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:setup-codes-2");
  });
});

describe("the two-factor setup steps", () => {
  it("the codes appear only after the first code is accepted, say this device stays signed in, and go when saved", async () => {
    const { host } = await toQr();
    expect(found(host, CODES)).toEqual([]);
    expect(host.textContent).toMatch(/other devices were signed out/i);
    fill(host, "code", "123456");
    click(byText(host, "button", "Turn on"));
    await settle();
    expect(found(host, CODES)).toEqual(CODES);
    expect(host.textContent).toMatch(/this device stays signed in/i);
    click(byText(host, "button", "I saved my codes"));
    await settle();
    expect(found(host, CODES)).toEqual([]);
    expect(host.textContent).toMatch(/two-step verification is on/i);
  });

  it("a wrong code empties the field and keeps the secret for another try", async () => {
    const { host } = await toCodes({ verifyTotp: () => refusal("invalid_credentials", 401) });
    expect(field(host, "code")?.value).toBe("");
    expect(host.textContent).toContain(SECRET);
    expect(found(host, CODES)).toEqual([]);
  });
});

describe("the two-factor setup failures", () => {
  const NO_SECRET = "otpauth://totp/Shoutory:x?issuer=Shoutory";
  it.each([
    [
      "too many attempts at the password step",
      "password",
      { verifyPassword: () => refusal("too_many_requests", 429) },
    ],
    [
      "an unavailable server at the password step",
      "password",
      { enable: () => refusal("service_unavailable", 503) },
    ],
    [
      "a setup answer with no secret",
      "password",
      { enable: () => json({ totpURI: NO_SECRET, backupCodes: CODES }) },
    ],
    ["too many attempts at the code step", "code", { verifyTotp: () => refusal("too_many_requests", 429) }],
  ])("%s keeps the typed value and shows the error panel", async (_name, input, api) => {
    const { host } = input === "code" ? await toCodes(api) : await toQr(api);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(field(host, input)?.value).toBe(input === "code" ? "123456" : PASSWORD);
  });
});

describe("the two-factor setup copy", () => {
  it("copy puts the secret, and later the codes, on the clipboard", async () => {
    const { host } = await toQr();
    click(byText(host, "button", "Copy secret"));
    await settle();
    expect(writeText).toHaveBeenLastCalledWith(SECRET);
    fill(host, "code", "123456");
    click(byText(host, "button", "Turn on"));
    await settle();
    click(byText(host, "button", "Copy codes"));
    await settle();
    expect(writeText).toHaveBeenLastCalledWith(CODES.join("\n"));
  });
});
