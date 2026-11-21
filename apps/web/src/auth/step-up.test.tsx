import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { byText, click, closeApp, json, mountRouted, refusal, type } from "../../test/support/app";
import { ApiError, request } from "../http/client";
import { StepUpProvider, useStepUp } from "./step-up";

afterEach(closeApp);

const PASSWORD = "correct horse battery 7";
const settle = () => act(async () => undefined);
const done = z.object({ ok: z.boolean() });

// Two sensitive calls started together; each answers 403 step_up_required until the password was verified.
function Probe() {
  const stepUp = useStepUp();
  const [results, setResults] = useState<string[]>([]);
  const run = (path: string) =>
    stepUp(() => request(done, path, { method: "POST", body: {} })).then(
      () => setResults((now) => [...now, "ok"]),
      (error: unknown) => setResults((now) => [...now, error instanceof ApiError ? error.code : "bug"]),
    );
  return (
    <>
      <button type="button" onClick={() => void Promise.all([run("/api/v1/a"), run("/api/v1/b")])}>
        Run both
      </button>
      <output>{results.join(",")}</output>
    </>
  );
}

function setup(options: { verify?: () => Response; alwaysRefuse?: boolean } = {}) {
  let verified = false;
  const stub = vi.fn((path: string, _init?: RequestInit) => {
    const url = new URL(path, "http://same-origin.invalid").pathname;
    if (url === "/api/auth/verify-password") {
      const answer = options.verify?.() ?? json({ status: true });
      if (answer.ok) verified = true;
      return Promise.resolve(answer);
    }
    const allowed = verified && !options.alwaysRefuse;
    return Promise.resolve(allowed ? json({ data: { ok: true } }) : refusal("step_up_required", 403));
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}
const open = () =>
  mountRouted(
    [
      {
        path: "/",
        element: (
          <StepUpProvider>
            <Probe />
          </StepUpProvider>
        ),
      },
      { path: "/sign-in", element: <p>The sign-in page</p> },
    ],
    "/",
  );
const calls = (stub: ReturnType<typeof setup>, name: string) =>
  stub.mock.calls.filter(([path]) => path.includes(name));
const dialogs = () => document.querySelectorAll('[role="dialog"]');
const passwordField = () =>
  document.querySelector<HTMLInputElement>('[role="dialog"] input[name="password"]');

// `setup` must have run first: it installs the fetch stub the calls go through.
async function ask(_stub: ReturnType<typeof setup>) {
  const opened = await open();
  click(byText(opened.host, "button", "Run both"));
  await settle();
  return opened;
}
async function confirm(value = PASSWORD) {
  type(passwordField() as HTMLInputElement, value);
  click(byText(document.body, '[role="dialog"] button', "Confirm"));
  await settle();
}

// X-04, R410: one dialog for parallel 403s, each call replayed once, no loop, and nothing retried on a refusal.
describe("the step-up dialog (security floor)", () => {
  it("opens once for two 403s, verifies the password once and replays each call once", async () => {
    const stub = setup();
    const { host } = await ask(stub);
    expect(dialogs()).toHaveLength(1);
    await confirm();
    expect(calls(stub, "verify-password")).toHaveLength(1);
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([2, 2]);
    expect(host.querySelector("output")?.textContent).toBe("ok,ok");
    expect(dialogs()).toHaveLength(0);
  });

  it("sends the password to the verify route only, as {password} with the client header", async () => {
    const stub = setup();
    await ask(stub);
    await confirm();
    const [, init] = calls(stub, "verify-password")[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ password: PASSWORD });
    expect(new Headers(init?.headers).get("X-Shoutory-Client")).toBe("web");
    expect(stub.mock.calls.filter(([, i]) => String(i?.body).includes(PASSWORD))).toHaveLength(1);
  });

  it("a second 403 on the replay is returned and never loops", async () => {
    const stub = setup({ alwaysRefuse: true });
    const { host } = await ask(stub);
    await confirm();
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([2, 2]);
    expect(host.querySelector("output")?.textContent).toBe("step_up_required,step_up_required");
    expect(dialogs()).toHaveLength(0);
    // The password is gone from the page, and the calls keep refusing, so the next run asks again with an empty field.
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    click(byText(host, "button", "Run both"));
    await settle();
    expect(passwordField()?.value).toBe("");
  });
});

describe("the step-up dialog when the password is not confirmed", () => {
  it.each([
    ["wrong password", () => refusal("validation_failed", 400), /not right/i],
    ["too many attempts", () => refusal("too_many_requests", 429), /few minutes/i],
  ])("a %s keeps the dialog, retries nothing and clears the field", async (_name, verify, words) => {
    const stub = setup({ verify });
    await ask(stub);
    await confirm();
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.textContent).toMatch(words);
    expect(passwordField()?.value).toBe("");
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([1, 1]);
  });

  it("cancel retries nothing, returns the original refusal to both calls and clears the field", async () => {
    const stub = setup();
    const { host } = await ask(stub);
    type(passwordField() as HTMLInputElement, PASSWORD);
    click(byText(document.body, '[role="dialog"] button', "Cancel"));
    await settle();
    expect(calls(stub, "verify-password")).toHaveLength(0);
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([1, 1]);
    expect(host.querySelector("output")?.textContent).toBe("step_up_required,step_up_required");
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it("a reopened dialog shows no old error", async () => {
    const stub = setup({ verify: () => refusal("validation_failed", 400) });
    const { host } = await ask(stub);
    await confirm();
    expect(dialogs()[0]?.querySelector('[role="alert"]')).not.toBeNull();
    click(byText(document.body, '[role="dialog"] button', "Cancel"));
    click(byText(host, "button", "Run both"));
    await settle();
    expect(dialogs()[0]?.querySelector('[role="alert"]')).toBeNull();
  });

  it("a 401 while verifying the password goes to sign-in", async () => {
    const stub = setup({ verify: () => refusal("unauthenticated", 401) });
    const opened = await open();
    click(byText(opened.host, "button", "Run both"));
    await settle();
    await confirm();
    expect(opened.router.state.location.pathname).toBe("/sign-in");
    expect(calls(stub, "/api/v1/a")).toHaveLength(1);
  });
});

// X-04 code mode: an account with the second factor on is refused with `details.method: "totp"` and asked for a code.
const CODE = "123456";
const codeField = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[name="code"]');
const submit = async (value: string) => {
  type(codeField() as HTMLInputElement, value);
  click(byText(document.body, '[role="dialog"] button', "Confirm"));
  await settle();
};

// The server's answers to a code that is not right: 401 `invalid_credentials` for a well-formed wrong one, 400
// `validation_failed` for one that is not six digits (the `code` schema in apps/api auth/paths.ts).
const ANSWERS: Record<string, () => Response> = {
  "000000": () => refusal("invalid_credentials", 401),
  "12345": () => refusal("validation_failed", 400),
};

function setupCode(other: () => Response | undefined = () => undefined) {
  let verified = false;
  const stub = vi.fn((path: string, init?: RequestInit) => {
    const url = new URL(path, "http://same-origin.invalid").pathname;
    if (url === "/api/auth/two-factor/verify-totp") {
      const sent = JSON.parse(String(init?.body)).code as string;
      verified ||= sent === CODE;
      const answer = sent === CODE ? json({ user: { email: "a@example.test" } }) : ANSWERS[sent]?.();
      return Promise.resolve(answer ?? other() ?? refusal("invalid_credentials", 401));
    }
    return Promise.resolve(
      verified ? json({ data: { ok: true } }) : refusal("step_up_required", 403, { method: "totp" }),
    );
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("the step-up dialog for an account with the second factor on", () => {
  it("asks for a code, shows the 4-part error for a wrong one, then replays each call once for the right one", async () => {
    const stub = setupCode();
    const { host } = await open();
    click(byText(host, "button", "Run both"));
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(passwordField()).toBeNull();
    expect(codeField()?.autocomplete).toBe("one-time-code");
    expect([codeField()?.maxLength, codeField()?.inputMode]).toEqual([6, "numeric"]);
    await submit("000000");
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.textContent).toMatch(/code is not right/i);
    expect(calls(stub, "/api/v1/a")).toHaveLength(1);
    await submit(CODE);
    expect(calls(stub, "verify-password")).toHaveLength(0);
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([2, 2]);
    expect(host.querySelector("output")?.textContent).toBe("ok,ok");
    expect(dialogs()).toHaveLength(0);
  });
});

// R512 (Q4): a person who lost the device offers a recovery code in the same dialog; it goes to the backup-code route
// instead of the TOTP one and the refused calls are replayed once, as for a TOTP code.
describe("the step-up dialog's recovery code", () => {
  it("posts a recovery code to verify-backup-code and replays each call once", async () => {
    const RECOVERY = "abcd-efgh-1234";
    let verified = false;
    const stub = vi.fn((path: string, init?: RequestInit) => {
      const url = new URL(path, "http://same-origin.invalid").pathname;
      if (url === "/api/auth/two-factor/verify-backup-code") {
        verified = JSON.parse(String(init?.body)).code === RECOVERY;
        return Promise.resolve(
          verified ? json({ user: { email: "a@example.test" } }) : refusal("invalid_credentials", 401),
        );
      }
      return Promise.resolve(
        verified ? json({ data: { ok: true } }) : refusal("step_up_required", 403, { method: "totp" }),
      );
    });
    vi.stubGlobal("fetch", stub);
    const { host } = await open();
    click(byText(host, "button", "Run both"));
    await settle();
    click(byText(document.body, '[role="dialog"] button', "Use a recovery code"));
    await settle();
    // A recovery code is longer than six characters: the field takes it whole.
    expect(codeField()?.maxLength).not.toBe(6);
    await submit(RECOVERY);
    const [, init] = calls(stub, "verify-backup-code")[0] ?? [];
    expect(calls(stub, "verify-backup-code")).toHaveLength(1);
    expect(JSON.parse(String(init?.body))).toEqual({ code: RECOVERY });
    expect(calls(stub, "verify-totp")).toHaveLength(0);
    expect([calls(stub, "/api/v1/a").length, calls(stub, "/api/v1/b").length]).toEqual([2, 2]);
    expect(host.querySelector("output")?.textContent).toBe("ok,ok");
    expect(dialogs()).toHaveLength(0);
  });
});

describe("the step-up dialog's code mode when the code is not accepted", () => {
  it.each([
    ["a wrong code", "000000"],
    ["a code that is not six digits", "12345"],
  ])("%s shows the wrong-code words, never the password's", async (_name, sent) => {
    setupCode();
    const { host } = await open();
    click(byText(host, "button", "Run both"));
    await settle();
    await submit(sent);
    const text = dialogs()[0]?.textContent ?? "";
    expect(text).toMatch(/code is not right/i);
    expect(text).not.toMatch(/password/i);
  });

  it.each([
    ["a server error", () => refusal("internal_error", 500), /could not check the code/i],
    ["too many attempts", () => refusal("too_many_requests", 429), /few minutes/i],
  ])("%s names the code, never the password", async (_name, answer, words) => {
    setupCode(answer);
    const { host } = await open();
    click(byText(host, "button", "Run both"));
    await settle();
    await submit("999999");
    const text = dialogs()[0]?.textContent ?? "";
    expect(text).toMatch(words);
    expect(text).not.toMatch(/password/i);
  });
});
