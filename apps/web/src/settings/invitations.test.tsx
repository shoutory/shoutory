import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  callsTo,
  click,
  closeApp,
  INVITATIONS,
  openMembers,
  optionTexts,
  pageOf,
  pick,
  refusal,
  rowOf,
  selectTrigger,
  settle,
  type,
} from "../../test/support/app";

afterEach(closeApp);

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
const confirm = (label: string) => click(byText(document.body, '[role="dialog"] button', label));
const email = () => dialog().querySelector<HTMLInputElement>('input[name="email"]') as HTMLInputElement;

async function invite(caller: string, api = {}, address = "new@example.test") {
  const opened = await openMembers(caller, api);
  click(byText(opened.host, "button", "Invite"));
  await settle();
  type(email(), address);
  confirm("Send invitation");
  await settle();
  return opened;
}

describe("inviting a person", () => {
  it.each([
    ["the default role and 48 hours", {}, { role_key: "viewer", expires_in: 172_800 }],
    [
      "a chosen role and expiry",
      { Role: "Editor", "Expires after": "7 days" },
      { role_key: "editor", expires_in: 604_800 },
    ],
  ])(
    "sends the address and %s, closes only after the answer, then reads the list again",
    async (_name, picks, sent) => {
      const { host, stub } = await openMembers("admin");
      click(byText(host, "button", "Invite"));
      await settle();
      type(email(), "new@example.test");
      for (const [label, option] of Object.entries(picks)) pick(dialog(), label, option);
      confirm("Send invitation");
      await settle();
      const [call] = callsTo(stub, "POST", "/invitations");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ email: "new@example.test", ...sent });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(callsTo(stub, "GET", "/invitations")).toHaveLength(2);
    },
  );

  it("keeps the dialog open while the call runs, and a second press sends one POST", async () => {
    const { stub } = await invite("admin", { invite: () => new Promise<Response>(() => undefined) });
    confirm("Send invitation");
    await settle();
    expect(callsTo(stub, "POST", "/invitations")).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("the expiry list has the five presets", async () => {
    const { host } = await openMembers("admin");
    click(byText(host, "button", "Invite"));
    await settle();
    click(selectTrigger(dialog(), "Expires after"));
    expect(optionTexts()).toEqual(["1 hour", "24 hours", "48 hours", "7 days", "14 days"]);
  });

  it.each(["", "not an email", "x@"])("the address %j is refused before any call", async (address) => {
    const { stub } = await invite("admin", {}, address);
    expect(callsTo(stub, "POST", "/invitations")).toHaveLength(0);
    expect(dialog().textContent).toMatch(/valid email/i);
  });
});

describe("refusals to an invitation", () => {
  it.each([
    ["already invited", refusal("conflict", 409, { reason: "pending_duplicate" }), /already invited/i],
    ["at the limit of 100", refusal("limit_reached", 409), /100 pending/i],
    ["throttled", refusal("too_many_requests", 429), /too many/i],
  ])("a refusal %s has its own words and keeps the typed address", async (_name, answer, words) => {
    await invite("admin", { invite: () => answer.clone() });
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(words);
    expect(email().value).toBe("new@example.test");
  });

  it("a refused rank reads the lists again; an ended session goes to sign in", async () => {
    const rank = await invite("admin", { invite: () => refusal("forbidden", 403) });
    expect(callsTo(rank.stub, "GET", "/api/v1/workspaces?").length).toBeGreaterThan(1);
    closeApp();
    const ended = await invite("admin", { invite: () => refusal("unauthenticated", 401) });
    expect(ended.router.state.location.pathname).toBe("/sign-in");
  });
});

describe("revoking a pending invitation", () => {
  const revoke = async (api = {}, address = "pending@example.test") => {
    const opened = await openMembers("admin", api);
    click(byText(rowOf(opened.host, address), "button", "Revoke"));
    await settle();
    return opened;
  };

  // The second read of the list never answers: the table stays, and focus is on the section heading.
  it("names the invitee and sends nothing until confirmed, then reads the list again and keeps the table", async () => {
    let reads = 0;
    const list = pageOf(INVITATIONS);
    const { stub, host } = await revoke({
      invitations: () => (++reads === 1 ? list() : new Promise<Response>(() => undefined)),
    });
    expect(dialog().textContent).toContain("pending@example.test");
    expect(callsTo(stub, "DELETE", "/invitations/i1")).toHaveLength(0);
    confirm("Revoke");
    await settle();
    expect(callsTo(stub, "DELETE", "/invitations/i1")).toHaveLength(1);
    expect(callsTo(stub, "GET", "/invitations")).toHaveLength(2);
    expect(rowOf(host, "old@example.test")).toBeDefined();
    expect(document.activeElement).toBe(host.querySelector("h2"));
  });

  it("an invitation that already ended says so and the list is read again", async () => {
    const { stub } = await revoke({
      revokeInvitation: () => refusal("conflict", 409, { reason: "already_ended" }),
    });
    confirm("Revoke");
    await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toMatch(/no longer pending/i);
    expect(callsTo(stub, "GET", "/invitations").length).toBeGreaterThan(1);
  });

  it("an expired invitation is marked expired and can still be revoked", async () => {
    const { host } = await openMembers("admin");
    const row = rowOf(host, "old@example.test");
    expect(row.textContent).toMatch(/expired/i);
    expect(byText(row, "button", "Revoke")).toBeDefined();
  });
});
