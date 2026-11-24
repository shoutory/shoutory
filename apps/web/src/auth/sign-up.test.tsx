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

async function signUp(api: Parameters<typeof stubApi>[0] = {}, password = PASSWORD) {
  const stub = stubApi(api);
  const opened = await openApp("/sign-up");
  fill(opened.host, "name", "Sam Sample");
  fill(opened.host, "email", "new@example.test");
  fill(opened.host, "password", password);
  click(byText(opened.host, "button", "Create account"));
  await settle();
  return { ...opened, stub };
}
const signUpCalls = (stub: Awaited<ReturnType<typeof signUp>>["stub"]) =>
  stub.mock.calls.filter(([path]) => path.includes("/api/auth/sign-up/email"));

describe("the sign-up form (security floor)", () => {
  it("a submit is prevented, so the browser never sends a GET with the password in the URL", async () => {
    stubApi();
    const { host } = await openApp("/sign-up");
    const event = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void host.querySelector("form")?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["/sign-up", "name", "text", "name"],
    ["/sign-up", "email", "email", "email"],
    ["/sign-up", "password", "password", "new-password"],
    ["/forgot", "email", "email", "email"],
    ["/auth/reset#token=link-token-1", "password", "password", "new-password"],
  ])("%s: the %s field is type %s with autocomplete %s", async (path, name, kind, token) => {
    stubApi();
    const { host } = await openApp(path);
    const input = field(host, name);
    expect([input?.type, input?.getAttribute("autocomplete")]).toEqual([kind, token]);
  });

  it("sends only {name, email, password} with the client header and keeps the password out of the URL, storage and page after a failure", async () => {
    const { stub, host, router } = await signUp({ signUp: () => refusal("validation_failed", 400) });
    const [path, init] = signUpCalls(stub)[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Sam Sample",
      email: "new@example.test",
      password: PASSWORD,
    });
    expect(path).not.toContain("?");
    expect(stub.mock.calls.every(([url]) => !url.includes(PASSWORD))).toBe(true);
    expect(router.state.location.search + router.state.location.pathname).not.toContain(PASSWORD);
    expect(JSON.stringify([{ ...localStorage }, { ...sessionStorage }])).not.toContain(PASSWORD);
    expect(host.innerHTML).not.toContain(PASSWORD);
    expect(field(host, "password")?.value).toBe("");
  });

  it.each([
    ["a new address", { user: { name: "T", email: "new@example.test", emailVerified: false } }],
    ["a known address", { user: { name: "T", email: "new@example.test", emailVerified: true } }],
  ])("%s gets the same confirmation, which names no account", async (_name, body) => {
    const { host } = await signUp({ signUp: () => json(body) });
    const shown = host.querySelector('[role="status"]')?.textContent ?? "";
    expect(shown).toContain("Check your email");
    expect(shown).not.toMatch(/already|exists|taken|new@example/i);
    expect(field(host, "email")).toBeNull();
  });

  it("a password under 15 characters sends nothing and says why (the client checks the length only)", async () => {
    const { stub, host } = await signUp({}, "too short pw 1");
    expect(signUpCalls(stub)).toHaveLength(0);
    expect(host.textContent).toMatch(/15 characters/);
  });
});

describe("the sign-up modes and failures", () => {
  it("an invitation-only instance keeps the form and says so", async () => {
    stubApi({ signUpMode: () => json({ data: { open: false } }) });
    const { host } = await openApp("/sign-up");
    expect(host.textContent).toMatch(/invitation/i);
    expect(field(host, "email")).not.toBeNull();
  });

  it("a failed read of the mode keeps the form", async () => {
    stubApi({ signUpMode: () => refusal("service_unavailable", 503) });
    const { host } = await openApp("/sign-up");
    expect(field(host, "email")).not.toBeNull();
  });

  it.each([
    ["a refused password", "validation_failed", 400, /not accepted/i],
    ["too many attempts", "too_many_requests", 429, /few minutes/i],
    ["an unavailable server", "service_unavailable", 503, /not reachable/i],
  ])("%s has its own words", async (_name, code, status, words) => {
    const { host } = await signUp({ signUp: () => refusal(code, status) });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(words);
  });

  it("an unavailable server keeps the typed password, and Retry sends it again", async () => {
    const { host, stub } = await signUp({ signUp: () => refusal("service_unavailable", 503) });
    expect(field(host, "password")?.value).toBe(PASSWORD);
    click(byText(host, "button", "Retry"));
    await settle();
    const sent = signUpCalls(stub).map(([, init]) => JSON.parse(String(init?.body)).password);
    expect(sent).toEqual([PASSWORD, PASSWORD]);
  });

  it("shows busy and ignores a second press while the call is pending", async () => {
    const { host, stub } = await signUp({ signUp: () => new Promise<Response>(() => undefined) });
    const button = byText(host, "button", "Create account");
    click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(signUpCalls(stub)).toHaveLength(1);
  });
});
