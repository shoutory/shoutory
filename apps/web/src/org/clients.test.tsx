import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  type Organization,
  openApp,
  optionTexts,
  pageOf as page,
  pick,
  refusal,
  roleOf,
  rowOf,
  selectTrigger,
  settle,
  stubApi,
  type,
  WORKSPACES,
  type Workspace,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/o/o1/clients";
const org = (role: string): Organization[] => [
  { id: "o1", name: "Acme Agency", slug: "acme", type: "agency", org_role: role as Organization["org_role"] },
];
const calls = (stub: ReturnType<typeof stubApi>, post: boolean) =>
  stub.mock.calls.filter(([url, init]) =>
    post ? url === "/api/v1/workspaces" && init?.method === "POST" : url.startsWith("/api/v1/workspaces?"),
  );
const field = () => document.body.querySelector<HTMLInputElement>('input[name="name"]');
const add = (host: ParentNode) => byText<HTMLButtonElement>(host, "button", "Add client");
const create = () => click(byText(document.body, '[role="dialog"] button', "Create"));

describe("the clients list", () => {
  it("lists the organization's workspaces: each name opens it, with its Settings link and role", async () => {
    stubApi();
    const { host } = await openApp(PATH);
    const rows = [...host.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.querySelector("a")?.textContent)).toEqual(["Acme One", "Acme Two"]);
    expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe("/w/w1");
    expect(byText(rows[0] as HTMLElement, "a", "Settings").getAttribute("href")).toBe(
      "/w/w1/settings/general",
    );
    expect(rows[0]?.textContent).toMatch(/owner/i);
  });

  it.each([
    ["owner", false],
    ["admin", false],
    ["member", true],
    ["billing", true],
  ])(
    "a %s of the organization: Add client unavailable is %s, and says why when it is",
    async (role, blocked) => {
      stubApi({ organizations: page(org(role)) });
      const { host } = await openApp(PATH);
      expect(add(host).getAttribute("aria-disabled") === "true").toBe(blocked);
      if (!blocked) return;
      expect(host.textContent).toMatch(/only organization admins can add clients/i);
      click(add(host));
      await settle();
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it("an organization with no workspace shows the first-use state with Add your first client", async () => {
    stubApi({ workspaces: page([]) });
    const { host } = await openApp(PATH);
    expect(host.querySelector('[data-kind="first-use"]')).not.toBeNull();
    expect(host.textContent).toContain("Add your first client");
  });
});

describe("adding a client", () => {
  async function open(api: Parameters<typeof stubApi>[0] = {}, name = "New Client") {
    const lists = { organizations: page(org("owner")), workspaces: page(WORKSPACES.slice(0, 2)) };
    const stub = stubApi({ ...lists, ...api });
    const opened = await openApp(PATH);
    click(add(opened.host));
    await settle();
    type(field() as HTMLInputElement, name);
    create();
    await settle();
    return { ...opened, stub };
  }

  it("sends the organization, the name and a zone, no slug, then reads the lists again and closes", async () => {
    const { stub, host } = await open();
    const body = JSON.parse(String(calls(stub, true)[0]?.[1]?.body));
    expect(Object.keys(body).sort()).toEqual(["default_tz", "name", "organization_id"]);
    expect([body.organization_id, body.name]).toEqual(["o1", "New Client"]);
    const key = new Headers(calls(stub, true)[0]?.[1]?.headers).get("Idempotency-Key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls(stub, false)).toHaveLength(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("h1"));
    const status = [...host.querySelectorAll('main [role="status"]')].map((node) => node.textContent);
    expect(status.join(" ")).toMatch(/client added/i);
  });

  it("refuses an empty name before any call, and a second press while the call runs sends one POST", async () => {
    const empty = await open({}, "   ");
    expect(calls(empty.stub, true)).toHaveLength(0);
    expect(document.body.textContent).toMatch(/enter a name/i);
    closeApp();
    const pending = await open({ createWorkspace: () => new Promise<Response>(() => undefined) });
    create();
    await settle();
    expect(calls(pending.stub, true)).toHaveLength(1);
  });

  it.each([
    ["the 100 client limit", refusal("limit_reached", 409), /100 clients/i],
    ["a server failure", refusal("service_unavailable", 503), /not reachable/i],
    [
      "a key sent before with other details",
      refusal("unprocessable_content", 422, { reason: "idempotency_key_reused" }),
      /other details/i,
    ],
  ])("%s has its own words and keeps what was typed", async (_name, answer, words) => {
    await open({ createWorkspace: () => answer.clone() });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(words);
    expect(field()?.value).toBe("New Client");
  });

  it("an ended session sends the visitor to sign in", async () => {
    const { router } = await open({ createWorkspace: () => refusal("unauthenticated", 401) });
    expect(router.state.location.pathname).toBe("/sign-in");
  });
});

describe("adding a client from a template", () => {
  async function openWith(rows: Workspace[], api: Parameters<typeof stubApi>[0] = {}) {
    const stub = stubApi({ organizations: page(org("owner")), workspaces: page(rows), ...api });
    const opened = await openApp(PATH);
    click(add(opened.host));
    await settle();
    type(field() as HTMLInputElement, "New Client");
    return { ...opened, stub };
  }

  it("offers only active clients, sends the template and leaves the time zone to it", async () => {
    const rows = [WORKSPACES[0], { ...WORKSPACES[1], archived_at: GONE }] as Workspace[];
    const { stub } = await openWith(rows);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Time zone");
    click(selectTrigger(document.body, "Copy settings from"));
    expect(optionTexts()).toEqual(["No template", "Acme One"]);
    pick(document.body, "Copy settings from", "Acme One");
    expect(dialog.textContent).not.toContain("Time zone");
    create();
    await settle();
    const body = JSON.parse(String(calls(stub, true)[0]?.[1]?.body));
    expect(body).toEqual({ organization_id: "o1", name: "New Client", template_workspace_id: "w1" });
  });

  it("has no template choice when every client is archived", async () => {
    await openWith([{ ...(WORKSPACES[0] as Workspace), archived_at: GONE }]);
    expect(() => selectTrigger(document.body, "Copy settings from")).toThrow();
  });

  it.each([
    ["with a template, names the template", "Acme Two", true],
    ["without one, does not blame a template", "", false],
  ])("a not-found answer %s", async (_name, template, blamed) => {
    await openWith(WORKSPACES.slice(0, 2), { createWorkspace: () => refusal("not_found", 404) });
    if (template) pick(document.body, "Copy settings from", template);
    create();
    await settle();
    const alert = document.body.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).not.toBe("");
    expect(/template client is no longer available/i.test(alert)).toBe(blamed);
  });
});

const GONE = "2026-11-25T10:00:00.000Z";
// The lists read back what the server holds: archive and restore change it, the next read shows it.
function archivable(rows: Workspace[]) {
  const held = new Map(rows.map((row) => [row.id, row.archived_at]));
  return {
    workspaces: () => page(rows.map((row) => ({ ...row, archived_at: held.get(row.id) ?? null })))(),
    archive: (action: string, id: string) => {
      held.set(id, action === "archive" ? GONE : null);
      return json({ data: { id, archived_at: held.get(id) ?? null } });
    },
  };
}
const archiveCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url, init]) => /\/(un)?archive$/.test(url) && init?.method === "POST");

describe("archiving and restoring a client", () => {
  it("archive states its impact, hides the row after the answer, and Restore from the shown row undoes it", async () => {
    const stub = stubApi({ organizations: page(org("owner")), ...archivable(WORKSPACES.slice(0, 2)) });
    const { host } = await openApp(PATH);
    click(byText(rowOf(host, "Acme One"), "button", "Archive"));
    await settle();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toMatch(/read-only.*nothing in it is published.*restore undoes this/i);
    click(byText(dialog, "button", "Archive"));
    await settle();
    expect(archiveCalls(stub).map(([url]) => url)).toEqual(["/api/v1/workspaces/w1/archive"]);
    expect(host.textContent).not.toContain("Acme One");
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(document.activeElement).toBe(host.querySelector("main"));
    click(byText(host, "label", "Show archived clients"));
    expect(rowOf(host, "Acme One").textContent).toContain("(Archived)");
    click(byText(rowOf(host, "Acme One"), "button", "Restore"));
    await settle();
    expect(archiveCalls(stub).map(([url]) => url)[1]).toBe("/api/v1/workspaces/w1/unarchive");
    expect(rowOf(host, "Acme One").textContent).not.toContain("(Archived)");
  });

  it("a refusal keeps the row as it was and names the reason", async () => {
    stubApi({
      organizations: page(org("owner")),
      archive: () => refusal("conflict", 409, { reason: "deletion_requested" }),
    });
    const { host } = await openApp(PATH);
    click(byText(rowOf(host, "Acme One"), "button", "Archive"));
    await settle();
    click(byText(document.body, '[role="dialog"] button', "Archive"));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toMatch(/being deleted/i);
    expect(rowOf(host, "Acme One").textContent).not.toContain("(Archived)");
  });

  it("when every client is archived the list says so and Clear filters shows them", async () => {
    const rows = WORKSPACES.slice(0, 2).map((row) => ({ ...row, archived_at: GONE }));
    stubApi({ organizations: page(org("owner")), workspaces: page(rows) });
    const { host } = await openApp(PATH);
    expect(host.querySelector('[data-kind="filtered-out"]')?.textContent).toMatch(
      /every client is archived/i,
    );
    click(byText(host, "button", "Clear filters"));
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  });
});

describe("who may archive a client", () => {
  it.each(["editor", "viewer"])(
    "a %s sees Archive unavailable with the reason stated once for the list, and sends nothing",
    async (role) => {
      const rows = WORKSPACES.slice(0, 2).map((row) => ({ ...row, role }));
      const stub = stubApi({ organizations: page(org("owner")), workspaces: page(rows) });
      const { host } = await openApp(PATH);
      const button = byText<HTMLButtonElement>(rowOf(host, "Acme Two"), "button", "Archive");
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(host.textContent?.match(/only an owner or admin can archive/gi)).toHaveLength(1);
      const note = document.getElementById(button.getAttribute("aria-describedby") ?? "");
      expect(note?.textContent).toMatch(/only an owner or admin can archive/i);
      click(button);
      await settle();
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(archiveCalls(stub)).toHaveLength(0);
    },
  );
});

describe("a client's picture", () => {
  it("is its thumbnail, and its first letter when the picture cannot be shown", async () => {
    const pictured = { ...(WORKSPACES[0] as Workspace), avatar: "m1" };
    stubApi({ organizations: page(org("owner")), workspaces: page([pictured]) });
    const { host } = await openApp(PATH);
    const avatar = host.querySelector('[data-testid="workspace-avatar"]') as HTMLElement;
    const image = avatar.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/api/v1/workspaces/w1/media/m1/derivatives/thumb");
    act(() => image.dispatchEvent(new Event("error")));
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
  });
});
