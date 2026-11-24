import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  type Organization,
  openApp,
  pageOf as page,
  refusal,
  settle,
  stubApi,
  type,
  WORKSPACES,
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
