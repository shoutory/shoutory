import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { byText, click, closeApp, openApp, refusal, stubApi, type } from "../../test/support/app";

afterEach(closeApp);

const settle = () => act(async () => undefined);
function code(host: ParentNode): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[name="code"]');
  if (!input) throw new Error('the page has no input named "code"');
  return input;
}

async function verify(path: string, api: Parameters<typeof stubApi>[0] = {}, value = "123456") {
  const stub = stubApi(api);
  const opened = await openApp(path);
  type(code(opened.host), value);
  click(byText(opened.host, "button", "Verify"));
  await settle();
  return { ...opened, stub };
}
const callsTo = (stub: ReturnType<typeof stubApi>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));

describe("after the challenge succeeds (security floor)", () => {
  it.each([
    ["a path on this origin", "/w/w2", "/w/w2"],
    ["a protocol-relative URL", "//evil.example.test", "/w/w1"],
    ["a backslash form", "/\\evil.example.test", "/w/w1"],
    ["an absolute URL", "https://evil.example.test/x", "/w/w1"],
  ])("return-to as %s lands on %s", async (_name, value, lands) => {
    const { router } = await verify(`/mfa?return-to=${encodeURIComponent(value)}`);
    expect(router.state.location.pathname).toBe(lands);
  });
});

describe("the challenge failures", () => {
  it.each([
    ["a wrong code", "invalid_credentials", 401, /code is not right/i],
    ["an expired challenge", "unauthenticated", 401, /expired/i],
    ["too many attempts", "too_many_requests", 429, /few minutes/i],
    ["a closed challenge (400)", "validation_failed", 400, /expired/i],
  ])("%s says so and stays on /mfa", async (_name, errorCode, status, words) => {
    const { host, router } = await verify("/mfa", { verifyTotp: () => refusal(errorCode, status) });
    expect(router.state.location.pathname).toBe("/mfa");
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(words);
  });

  it("an expired challenge offers to start again at /sign-in", async () => {
    const { host } = await verify("/mfa", { verifyTotp: () => refusal("unauthenticated", 401) });
    expect(byText(host, "a", "Start again").getAttribute("href")).toBe("/sign-in");
  });
});

describe("the recovery code", () => {
  it("is a toggle: the code goes to the recovery route instead of the TOTP route", async () => {
    const stub = stubApi();
    const { host } = await openApp("/mfa");
    click(byText(host, "button", "Use a recovery code"));
    type(code(host), "abcde-12345");
    click(byText(host, "button", "Verify"));
    await settle();
    const [, init] = callsTo(stub, "verify-backup-code")[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ code: "abcde-12345" });
    expect(callsTo(stub, "verify-totp")).toHaveLength(0);
  });

  it("the TOTP code goes to its route as {code} with the client header", async () => {
    const { stub } = await verify("/mfa");
    const [, init] = callsTo(stub, "verify-totp")[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ code: "123456" });
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
  });

  it("shows busy and ignores a second press while the call is pending", async () => {
    const { host, stub } = await verify("/mfa", { verifyTotp: () => new Promise<Response>(() => undefined) });
    const button = byText(host, "button", "Verify");
    click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(callsTo(stub, "verify-totp")).toHaveLength(1);
  });
});
