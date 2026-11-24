import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, json, openApp, refusal, stubApi, type } from "../../test/support/app";

afterEach(closeApp);

const PASSWORD = "correct horse battery 7";
const settle = () => act(async () => undefined);
const field = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
function fill(host: ParentNode, name: string, value: string) {
  const input = field(host, name);
  if (!input) throw new Error(`the page has no input named "${name}"`);
  type(input, value);
}

async function submit(
  path = "/sign-in",
  api: Parameters<typeof stubApi>[0] = {},
  locale: "en" | "ar" = "en",
) {
  const stub = stubApi(api);
  const opened = await openApp(path, locale);
  fill(opened.host, "email", "person@example.test");
  fill(opened.host, "password", PASSWORD);
  click(byText(opened.host, "button", locale === "en" ? "Sign in" : "تسجيل الدخول"));
  await settle();
  return { ...opened, stub };
}
const signInCalls = (stub: Awaited<ReturnType<typeof submit>>["stub"]) =>
  stub.mock.calls.filter(([path]) => path.includes("/api/auth/sign-in/email"));

describe("the sign-in form (security floor)", () => {
  it("a submit is prevented, so the browser never sends a GET with the password in the URL", async () => {
    stubApi();
    const { host } = await openApp("/sign-in");
    const event = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void host.querySelector("form")?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["/sign-in", "email", "email", "username"],
    ["/sign-in", "password", "password", "current-password"],
    ["/mfa", "code", "text", "one-time-code"],
  ])("%s: the %s field is type %s with autocomplete %s", async (path, name, kind, token) => {
    stubApi();
    const { host } = await openApp(path);
    const input = field(host, name);
    expect([input?.type, input?.getAttribute("autocomplete")]).toEqual([kind, token]);
  });

  it("sends a POST with only {email, password} and the client header, and keeps the password out of the URL, storage and page after a failure", async () => {
    const { stub, host, router } = await submit("/sign-in", {
      signIn: () => refusal("invalid_credentials", 401),
    });
    const [path, init] = signInCalls(stub)[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "person@example.test", password: PASSWORD });
    expect(stub.mock.calls.every(([url]) => !url.includes(PASSWORD))).toBe(true);
    expect(path).not.toContain("?");
    expect(router.state.location.search + router.state.location.pathname).not.toContain(PASSWORD);
    expect(JSON.stringify([{ ...localStorage }, { ...sessionStorage }])).not.toContain(PASSWORD);
    expect(host.innerHTML).not.toContain(PASSWORD);
    expect(field(host, "password")?.value).toBe("");
  });

  it.each([
    ["en", /lock|locked|minute|second|hour|unlock/i],
    ["ar", /مقفل|قفل|دقيقة|دقائق|ثانية|ثوان|ساعة/],
  ] as const)("the %s wrong-credentials copy names no lock and no time", async (locale, forbidden) => {
    const { host } = await submit("/sign-in", { signIn: () => refusal("invalid_credentials", 401) }, locale);
    const shown = host.querySelector('[role="alert"]')?.textContent ?? "";
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toMatch(forbidden);
  });

  it("moves focus to the error after a failed submit", async () => {
    const { host } = await submit("/sign-in", { signIn: () => refusal("invalid_credentials", 401) });
    expect(host.querySelector('[role="alert"]')?.contains(document.activeElement)).toBe(true);
  });
});

describe("after a successful sign-in", () => {
  it.each([
    ["a path on this origin", "/w/w2", "/w/w2"],
    ["a protocol-relative URL", "//evil.example.test", "/w/w1"],
    ["an absolute URL", "https://evil.example.test/x", "/w/w1"],
  ])("return-to as %s lands on %s", async (_name, value, lands) => {
    const { router } = await submit(`/sign-in?return-to=${encodeURIComponent(value)}`);
    expect(router.state.location.pathname).toBe(lands);
  });

  it("a challenge goes to /mfa and keeps return-to", async () => {
    const { router } = await submit("/sign-in?return-to=%2Fw%2Fw2", {
      signIn: () => json({ twoFactorRedirect: true }),
    });
    expect(router.state.location.pathname).toBe("/mfa");
    expect(router.state.location.search).toBe("?return-to=%2Fw%2Fw2");
  });
});

describe("the sign-in failures", () => {
  it.each([
    ["an unverified email", "email_not_verified", 403, /Confirm your email/, "Send the link again"],
    ["a breached password", "password_reset_required", 403, /new password/, "Reset your password"],
    ["too many attempts", "too_many_requests", 429, /few minutes/, null],
    ["an unavailable server", "service_unavailable", 503, /not reachable/, "Retry"],
  ])("%s has its own words and next step", async (_name, code, status, words, action) => {
    const { host } = await submit("/sign-in", { signIn: () => refusal(code, status) });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(words);
    expect(alert?.textContent).not.toMatch(/words the user must never see/);
    if (action) expect(byText(host, "button, a", action)).toBeDefined();
  });

  it("a 503 keeps the password and Retry sends it again: the request never reached the server", async () => {
    const { host, stub } = await submit("/sign-in", { signIn: () => refusal("service_unavailable", 503) });
    expect(field(host, "password")?.value).toBe(PASSWORD);
    click(byText(host, '[role="alert"] button', "Retry"));
    await settle();
    const sent = signInCalls(stub).map(([, init]) => JSON.parse(String(init?.body)));
    expect(sent).toEqual([
      { email: "person@example.test", password: PASSWORD },
      { email: "person@example.test", password: PASSWORD },
    ]);
  });

  it("the resend sends the email to the verification route and says so", async () => {
    const { host, stub } = await submit("/sign-in", { signIn: () => refusal("email_not_verified", 403) });
    click(byText(host, "button", "Send the link again"));
    await settle();
    const [, init] = stub.mock.calls.find(([path]) => path.includes("send-verification-email")) ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ email: "person@example.test" });
    expect(host.textContent).toContain("We sent the link again");
  });
});

describe("the sign-in button", () => {
  it("shows busy and ignores a second press while the call is pending", async () => {
    const { host, stub } = await submit("/sign-in", { signIn: () => new Promise<Response>(() => undefined) });
    const button = byText(host, "button", "Sign in");
    click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(signInCalls(stub)).toHaveLength(1);
  });

  it("is aria-disabled with its reason while offline and sends nothing", async () => {
    const stub = stubApi();
    const { host } = await openApp("/sign-in");
    act(() => void window.dispatchEvent(new Event("offline")));
    const button = byText(host, "button", "Sign in");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(
      /offline/i,
    );
    click(button);
    expect(signInCalls(stub)).toHaveLength(0);
  });
});

describe("the auth routes", () => {
  it.each([
    ["/sign-in", "/sign-in"],
    ["/mfa", "/mfa"],
    ["/auth/sign-in", "/sign-in"],
  ])("%s lands on %s and asks for no session", async (path, lands) => {
    const stub = stubApi();
    const { router } = await openApp(path);
    expect(router.state.location.pathname).toBe(lands);
    expect(stub.mock.calls.some(([url]) => url.includes("get-session"))).toBe(false);
  });
});
