import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, openApp, refusal, stubApi, type } from "../../test/support/app";

afterEach(closeApp);

const TOKEN = "link-token-4f9a1c";
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
type Call = readonly [string, (RequestInit | undefined)?];
const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.[1]?.body));

describe("a page opened from a mailed link (security floor)", () => {
  it.each([
    ["verify", `/auth/verify#token=${TOKEN}`, "verify-email", "Confirm my email"],
    ["reset", `/auth/reset#token=${TOKEN}`, "reset-password", "Set new password"],
  ])(
    "%s: no request on load, one POST on press, and the token is in no URL, title or link",
    async (_n, path, route, press) => {
      const stub = stubApi();
      const { host, router } = await openApp(path);
      expect(stub.mock.calls.some(([url]) => url.includes("/api/auth/"))).toBe(false);
      expect(router.state.location.hash).toBe("");
      expect(router.state.historyAction).toBe("REPLACE");
      expect(document.title).not.toContain(TOKEN);
      expect([...host.querySelectorAll("a")].every((link) => !link.href.includes(TOKEN))).toBe(true);
      if (route === "reset-password") fill(host, "password", "correct horse battery 7");
      click(byText(host, "button", press));
      await settle();
      expect(callsTo(stub, route)).toHaveLength(1);
      expect(bodyOf(callsTo(stub, route)[0])).toMatchObject({ token: TOKEN });
      expect(stub.mock.calls.every(([url]) => !url.includes(TOKEN))).toBe(true);
      expect(router.state.location.search + router.state.location.pathname).not.toContain(TOKEN);
    },
  );

  it.each([
    ["verify", "/auth/verify", "Confirm my email"],
    ["reset", "/auth/reset", "Set new password"],
    ["verify with an empty token", "/auth/verify#token=", "Confirm my email"],
  ])("%s without a token shows the bad-link state and sends nothing", async (_name, path, press) => {
    const stub = stubApi();
    const { host } = await openApp(path);
    expect(host.textContent).toContain("This link cannot be used");
    expect(() => byText(host, "button", press)).toThrow();
    expect(stub.mock.calls.some(([url]) => url.includes("/api/auth/"))).toBe(false);
  });
});

describe("the email-verify page", () => {
  it("confirms the email and offers sign-in", async () => {
    stubApi();
    const { host } = await openApp(`/auth/verify#token=${TOKEN}`);
    click(byText(host, "button", "Confirm my email"));
    await settle();
    expect(host.textContent).toContain("Your email is confirmed");
    expect(byText(host, "a", "Sign in").getAttribute("href")).toBe("/sign-in");
  });

  it("a dead link asks for the email, sends a new link and confirms it", async () => {
    const stub = stubApi({ verifyEmail: () => refusal("link_unusable", 400) });
    const { host } = await openApp(`/auth/verify#token=${TOKEN}`);
    click(byText(host, "button", "Confirm my email"));
    await settle();
    expect(host.textContent).toContain("This link cannot be used");
    fill(host, "email", "someone@example.test");
    click(byText(host, "button", "Send a new link"));
    await settle();
    expect(bodyOf(callsTo(stub, "send-verification-email")[0])).toEqual({ email: "someone@example.test" });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("we sent a new link");
  });

  it("a state swap moves focus to the new state's heading", async () => {
    stubApi({ verifyEmail: () => refusal("link_unusable", 400) });
    const { host } = await openApp(`/auth/verify#token=${TOKEN}`);
    click(byText(host, "button", "Confirm my email"));
    await settle();
    expect(document.activeElement?.tagName).toMatch(/^H[12]$/);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("too many attempts says to wait a few minutes", async () => {
    stubApi({ verifyEmail: () => refusal("too_many_requests", 429) });
    const { host } = await openApp(`/auth/verify#token=${TOKEN}`);
    click(byText(host, "button", "Confirm my email"));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/few minutes/i);
  });
});

describe("the forgot-password page", () => {
  it("sends only {email} with the client header", async () => {
    const stub = stubApi();
    const { host } = await openApp("/forgot");
    fill(host, "email", "someone@example.test");
    click(byText(host, "button", "Send the link"));
    await settle();
    const [call] = callsTo(stub, "request-password-reset");
    expect(bodyOf(call)).toEqual({ email: "someone@example.test" });
    expect(new Headers(call?.[1]?.headers).get("X-Shoutory-Client")).toBe("web");
  });

  it.each(["known@example.test", "nobody@example.test"])(
    "%s gets the same confirmation, which names no address",
    async (email) => {
      stubApi();
      const { host } = await openApp("/forgot");
      fill(host, "email", email);
      click(byText(host, "button", "Send the link"));
      await settle();
      const shown = host.querySelector('[role="status"]')?.textContent ?? "";
      expect(shown).toBe("If an address matches, we sent a link to reset the password.");
    },
  );

  it("too many attempts says to wait a few minutes", async () => {
    stubApi({ requestReset: () => refusal("too_many_requests", 429) });
    const { host } = await openApp("/forgot");
    fill(host, "email", "someone@example.test");
    click(byText(host, "button", "Send the link"));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/few minutes/i);
  });
});

async function resetWith(password: string, api: Parameters<typeof stubApi>[0] = {}) {
  const stub = stubApi(api);
  const opened = await openApp(`/auth/reset#token=${TOKEN}`);
  fill(opened.host, "password", password);
  click(byText(opened.host, "button", "Set new password"));
  await settle();
  return { ...opened, stub };
}

describe("the reset page", () => {
  it("a password under 15 characters sends nothing and says why", async () => {
    const { stub, host } = await resetWith("too short pw 1");
    expect(callsTo(stub, "reset-password")).toHaveLength(0);
    expect(host.textContent).toMatch(/15 characters/);
  });

  it("success says other sessions ended and does not sign in", async () => {
    const { stub, host } = await resetWith("correct horse battery 7");
    expect(host.textContent).toContain("Other devices were signed out");
    expect(callsTo(stub, "sign-in")).toHaveLength(0);
    expect(byText(host, "a", "Sign in").getAttribute("href")).toBe("/sign-in");
  });

  it("a dead link (link_unusable) offers a new one", async () => {
    const { host } = await resetWith("correct horse battery 7", {
      resetPassword: () => refusal("link_unusable", 400),
    });
    expect(host.textContent).toContain("This link cannot be used");
    expect(host.innerHTML).not.toContain("correct horse battery 7");
    expect(field(host, "password")).toBeNull();
    expect(byText(host, "a", "Send a new link").getAttribute("href")).toBe("/forgot");
  });

  it("a refused password keeps the form and the token: the next press sends the same token", async () => {
    const { stub, host } = await resetWith("correct horse battery 7", {
      resetPassword: () => refusal("validation_failed", 400),
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not accepted/i);
    expect(field(host, "password")?.value).toBe("");
    expect(host.innerHTML).not.toContain("correct horse battery 7");
    fill(host, "password", "another horse battery 9");
    click(byText(host, "button", "Set new password"));
    await settle();
    const sent = callsTo(stub, "reset-password").map(bodyOf);
    expect(sent.map((body) => body.token)).toEqual([TOKEN, TOKEN]);
    expect(sent[1].newPassword).toBe("another horse battery 9");
  });

  it("too many attempts says to wait a few minutes and keeps the typed password", async () => {
    const { host } = await resetWith("correct horse battery 7", {
      resetPassword: () => refusal("too_many_requests", 429),
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/few minutes/i);
    expect(field(host, "password")?.value).toBe("correct horse battery 7");
  });
});

describe("the auth pages of 11d2", () => {
  it.each(["/sign-up", "/forgot", "/auth/verify", "/auth/reset"])("%s asks for no session", async (path) => {
    const stub = stubApi();
    await openApp(path);
    expect(stub.mock.calls.some(([url]) => url.includes("get-session"))).toBe(false);
  });
});
