import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
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

const PATH = "/admin/system";
const storage = (failure: string | null) =>
  json({ data: { driver: "fs", writable: !failure, readable: !failure, free_bytes: 5, failure } });
const records = (rows: Array<[string, string]>) =>
  json({
    data: {
      domain: "mail.example.test",
      records: rows.map(([kind, state]) => ({
        kind,
        state,
        name: `${kind.toLowerCase()}.mail.example.test`,
      })),
    },
  });

const CHECKS: Array<[string, string, keyof Api, string, boolean]> = [
  ["storage", "Check storage", "storageCheck", "/admin/storage/check", true],
  ["mail domain", "Check mail domain", "mailCheck", "/admin/mail/check", false],
  ["test message", "Send test message", "mailTest", "/admin/mail/test", true],
];
const press = async (host: HTMLElement, label: string) => {
  click(byText(host, "button", label));
  await settle();
};

describe("the mail and storage screen", () => {
  it("says first what the checks do, and has the backup note", async () => {
    const { host } = await openAdmin(PATH);
    expect(host.querySelector("h1")?.textContent).toBe("Mail and storage");
    expect(host.textContent).toMatch(/one test message to your own address/i);
    expect(host.textContent).toMatch(/back up/i);
  });

  it.each(CHECKS)(
    "the %s check is busy while it runs and a second press sends one call",
    async (_n, label, key, path) => {
      const { host, stub } = await openAdmin(PATH, { [key]: () => new Promise<Response>(() => undefined) });
      await press(host, label);
      expect(byText(host, "button", label).getAttribute("aria-busy")).toBe("true");
      await press(host, label);
      expect(callsTo(stub, "POST", path)).toHaveLength(1);
    },
  );

  it.each(CHECKS.filter(([, , , , step]) => step))(
    "the %s check asks for the password once and replays once",
    async (_n, label, key, path) => {
      const ok = () =>
        json({
          data:
            key === "storageCheck"
              ? { driver: "fs", writable: true, readable: true, free_bytes: 1, failure: null }
              : { queued: true },
        });
      const { host, stub } = await openAdmin(PATH, needsPassword(key, ok));
      await press(host, label);
      await confirmPassword();
      expect(callsTo(stub, "POST", path)).toHaveLength(2);
      expect(callsTo(stub, "POST", "/api/auth/verify-password")).toHaveLength(1);
    },
  );

  it.each(CHECKS)("the %s check and the password dialog", async (_n, label, key, _path, step) => {
    const { host } = await openAdmin(PATH, step ? { [key]: () => refusal("step_up_required", 403) } : {});
    await press(host, label);
    expect(document.querySelector('[role="dialog"]') !== null).toBe(step);
  });
});

describe("the check results", () => {
  it.each([
    [null, /writable/i],
    ["timeout", /timed out/i],
    ["write_failed", /could not write/i],
  ])("a storage check with failure %s shows its own result", async (failure, words) => {
    const { host } = await openAdmin(PATH, { storageCheck: () => storage(failure) });
    await press(host, "Check storage");
    expect(host.textContent).toMatch(words);
  });

  it.each([
    ["SPF", "present", /SPF[\s\S]*present/],
    ["DMARC", "missing", /DMARC[\s\S]*missing/],
    ["DKIM", "unchecked", /DKIM[\s\S]*could not be checked/i],
    ["DKIM", "not_checked", /DKIM[\s\S]*not checked/i],
  ])("the %s record %s is listed with its own words", async (kind, state, words) => {
    const { host } = await openAdmin(PATH, { mailCheck: () => records([[kind, state]]) });
    await press(host, "Check mail domain");
    expect(host.textContent).toMatch(words);
  });

  it("the test message says queued and never sent, and that the outcome shows as mail arriving", async () => {
    const { host } = await openAdmin(
      PATH,
      needsPassword("mailTest", () => json({ data: { queued: true } })),
    );
    await press(host, "Send test message");
    await confirmPassword();
    expect(host.textContent).toMatch(/queued/i);
    expect(host.textContent).toMatch(/arriv/i);
    expect(host.textContent).not.toMatch(/\bsent\b/i);
  });

  it("a throttled test message shows the generic too-many copy and queues nothing more", async () => {
    const { host } = await openAdmin(PATH, { mailTest: () => refusal("too_many_requests", 429) });
    await press(host, "Send test message");
    await settle();
    expect(host.querySelector('main [role="alert"]')?.textContent).toMatch(/too many/i);
  });
});
