import { afterEach, describe, expect, it } from "vitest";
import {
  type Api,
  byText,
  callsTo,
  click,
  closeApp,
  json,
  membersFor,
  openMembers,
  optionTexts,
  pageOf,
  pick,
  refusal,
  roleOf,
  rowOf,
  selectTrigger,
  settle,
  type,
  WORKSPACES,
} from "../../test/support/app";

afterEach(closeApp);

const confirm = (label: string) => click(byText(document.body, '[role="dialog"] button', label));
const remove = async (host: HTMLElement, name: string) => {
  click(byText(rowOf(host, name), "button", "Remove"));
  await settle();
};
const hasSelect = (row: HTMLElement) => row.querySelector('button[aria-haspopup="listbox"]') !== null;
const hasRemove = (row: HTMLElement) =>
  [...row.querySelectorAll("button")].some((b) => b.textContent === "Remove");

const sensitive: Array<[string, (host: HTMLElement) => Promise<void>, keyof Api, string]> = [
  [
    "a role change",
    async (host) => {
      pick(rowOf(host, "Editor Three"), "Role", "Viewer");
      await settle();
    },
    "changeRole",
    "PATCH",
  ],
  [
    "a removal",
    async (host) => {
      await remove(host, "Editor Three");
      confirm("Remove");
      await settle();
    },
    "removeMember",
    "DELETE",
  ],
];

describe("the members page", () => {
  it("lists the members with their role and status, the pending invitations and the note on organization admins", async () => {
    const { stub, host } = await openMembers("admin");
    const table = host.querySelector("table")?.textContent ?? "";
    for (const name of ["Owner Zero", "Person Sample", "Admin Two", "Editor Three", "Viewer Four"])
      expect(table).toContain(name);
    expect(rowOf(host, "Suspended Five").textContent).toMatch(/suspended/i);
    expect(host.textContent).toContain("pending@example.test");
    expect(host.textContent).toMatch(/without being listed/i);
    expect([callsTo(stub, "GET", "/members").length, callsTo(stub, "GET", "/invitations").length]).toEqual([
      1, 1,
    ]);
    for (const part of ["/members", "/invitations"])
      expect(callsTo(stub, "GET", part)[0]?.[0]).toContain("limit=100");
  });

  it("no pending invitation shows the empty state, and a failed read shows the error panel with Retry in the frame", async () => {
    const empty = await openMembers("admin", { invitations: pageOf([]) });
    expect(empty.host.textContent).toMatch(/no pending invitations/i);
    closeApp();
    const failed = await openMembers("admin", { members: () => refusal("service_unavailable", 503) });
    expect(failed.host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(failed.host.querySelector("nav")).not.toBeNull();
  });

  it.each(["editor", "approver", "viewer"])(
    "a %s sees the page unavailable, no list call, and can leave",
    async (role) => {
      const { stub, host } = await openMembers(role);
      expect(host.textContent).toMatch(/need the admin role/i);
      expect(callsTo(stub, "GET", "/members")).toHaveLength(0);
      expect(callsTo(stub, "GET", "/invitations")).toHaveLength(0);
      expect(byText(host, "button", "Leave workspace")).toBeDefined();
    },
  );

  it.each([
    ["owner", "Person Sample", false, false],
    ["owner", "Admin Two", true, true],
    ["owner", "Suspended Five", false, true],
    ["admin", "Owner Zero", false, false],
    ["admin", "Person Sample", false, false],
    ["admin", "Admin Two", false, false],
    ["admin", "Editor Three", true, true],
  ])(
    "as %s the row of %s has a role control: %s, a Remove button: %s",
    async (caller, name, role, removable) => {
      const { host } = await openMembers(caller);
      const row = rowOf(host, name);
      expect([hasSelect(row), hasRemove(row)]).toEqual([role, removable]);
    },
  );
});

describe("the Owner row", () => {
  it("says a workspace needs one Owner", async () => {
    const { host } = await openMembers("admin");
    expect(rowOf(host, "Owner Zero").textContent).toMatch(/needs one owner/i);
  });
});

describe("changing a role", () => {
  it.each(["owner", "admin"])(
    "as %s the role list offers Admin to Viewer and never Owner",
    async (caller) => {
      const { host } = await openMembers(caller);
      click(selectTrigger(rowOf(host, "Editor Three"), "Role"));
      expect(optionTexts()).toEqual(["Admin", "Editor", "Approver", "Viewer"]);
    },
  );

  it("sends the new role for that member and shows no dialog when the check is fresh", async () => {
    const { stub, host } = await openMembers("admin");
    pick(rowOf(host, "Editor Three"), "Role", "Viewer");
    await settle();
    const [call] = callsTo(stub, "PATCH", "/members/u3");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ role_key: "viewer" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(sensitive)("a refused rank on %s reads every list again", async (_name, act, key) => {
    const { stub, host } = await openMembers("admin", { [key]: () => refusal("forbidden", 403) });
    await act(host);
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    expect(callsTo(stub, "GET", "/api/v1/workspaces?").length).toBeGreaterThan(1);
    expect([callsTo(stub, "GET", "/members").length, callsTo(stub, "GET", "/invitations").length]).toEqual([
      2, 2,
    ]);
  });

  it("a role list is unavailable while its change runs, and the replay sends the confirmed role", async () => {
    let verified = false;
    const { stub, host } = await openMembers("admin", {
      changeRole: () => (verified ? json({ data: null }) : refusal("step_up_required", 403)),
      verifyPassword: () => {
        verified = true;
        return json({ status: true });
      },
    });
    const row = rowOf(host, "Editor Three");
    pick(row, "Role", "Viewer");
    await settle();
    const trigger = selectTrigger(row, "Role");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    click(trigger);
    expect(optionTexts()).toEqual([]);
    type(
      document.querySelector<HTMLInputElement>('[role="dialog"] input[name="password"]') as HTMLInputElement,
      "correct horse battery 7",
    );
    confirm("Confirm");
    await settle();
    const bodies = callsTo(stub, "PATCH", "/members/u3").map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([{ role_key: "viewer" }, { role_key: "viewer" }]);
  });
});

describe("the password check on a sensitive change", () => {
  const password = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[name="password"]');

  it.each(sensitive)("%s asks for the password once and replays once", async (_name, act, key, method) => {
    let verified = false;
    const answer = () => (verified ? json({ data: null }) : refusal("step_up_required", 403));
    const { stub, host } = await openMembers("admin", {
      [key]: answer,
      verifyPassword: () => {
        verified = true;
        return json({ status: true });
      },
    });
    await act(host);
    type(password() as HTMLInputElement, "correct horse battery 7");
    confirm("Confirm");
    await settle();
    expect(callsTo(stub, method, "/members/u3")).toHaveLength(2);
    expect(callsTo(stub, "POST", "/api/auth/verify-password")).toHaveLength(1);
  });

  it.each(sensitive)(
    "%s with the check cancelled changes nothing and says so",
    async (_name, act, key, method) => {
      const { stub, host } = await openMembers("admin", { [key]: () => refusal("step_up_required", 403) });
      await act(host);
      click(byText(document.body, '[role="dialog"] button', "Cancel"));
      await settle();
      expect(callsTo(stub, method, "/members/u3")).toHaveLength(1);
      expect(callsTo(stub, "POST", "/api/auth/verify-password")).toHaveLength(0);
      expect(host.textContent).toMatch(/nothing was changed/i);
      expect(rowOf(host, "Editor Three")).toBeDefined();
    },
  );
});

describe("removing a member", () => {
  it("names the member and sends nothing until confirmed, then reads the lists, keeps the table and closes", async () => {
    let reads = 0;
    const list = pageOf(membersFor("admin"));
    const { stub, host } = await openMembers("admin", {
      members: () => (++reads === 1 ? list() : new Promise<Response>(() => undefined)),
    });
    await remove(host, "Editor Three");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Editor Three");
    expect(callsTo(stub, "DELETE", "/members/u3")).toHaveLength(0);
    confirm("Remove");
    await settle();
    expect(callsTo(stub, "DELETE", "/members/u3")).toHaveLength(1);
    expect(callsTo(stub, "GET", "/members")).toHaveLength(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(rowOf(host, "Viewer Four")).toBeDefined();
    expect(document.activeElement).toBe(host.querySelector("h1"));
  });

  it.each([
    ["last_owner", /one owner/i],
    ["already_owner", /already the owner/i],
    ["use_leave", /leave workspace/i],
  ])("the refusal %s has its own words inside the dialog", async (reason, words) => {
    const { host } = await openMembers("admin", { removeMember: () => refusal("conflict", 409, { reason }) });
    await remove(host, "Editor Three");
    confirm("Remove");
    await settle();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toMatch(words);
  });

  it("a refused removal keeps the dialog's choice open with the error panel", async () => {
    const { host } = await openMembers("admin", { removeMember: () => refusal("service_unavailable", 503) });
    await remove(host, "Editor Three");
    confirm("Remove");
    await settle();
    expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
  });
});

describe("leaving a workspace", () => {
  it.each([["admin"], ["viewer"]])("a %s confirms, leaves and lands in another workspace", async (role) => {
    let left = false;
    const before = roleOf(role);
    const after = pageOf(WORKSPACES.slice(1));
    const { stub, host, router } = await openMembers(role, {
      workspaces: () => (left ? after() : before()),
      leave: () => {
        left = true;
        return json({ data: null });
      },
    });
    click(byText(host, "button", "Leave workspace"));
    await settle();
    expect(callsTo(stub, "POST", "/members/me/leave")).toHaveLength(0);
    confirm("Leave");
    await settle();
    expect(callsTo(stub, "POST", "/members/me/leave")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/w/w2");
    expect(document.body.textContent).not.toContain("Acme One");
  });

  it("the Owner, and an organization admin with no stored row, are offered no Leave", async () => {
    const owner = await openMembers("owner");
    expect(() => byText(owner.host, "button", "Leave workspace")).toThrow();
    closeApp();
    const implicit = await openMembers("admin", {
      members: pageOf(membersFor("admin").filter((m) => m.user_id !== "u1")),
    });
    expect(() => byText(implicit.host, "button", "Leave workspace")).toThrow();
  });
});
