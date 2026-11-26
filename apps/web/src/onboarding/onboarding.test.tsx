import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  json,
  NEW_ORG,
  NEW_WORKSPACE,
  type Organization,
  openApp,
  refusal,
  stubApi,
  type,
} from "../../test/support/app";

afterEach(closeApp);

const settle = () => act(async () => undefined);
const page = (rows: unknown[]) => () => json({ data: rows, meta: { next_cursor: null } });
const lists = (orgs: unknown[], workspaces: unknown[] = []) => ({
  organizations: page(orgs),
  workspaces: page(workspaces),
});
const owned = (over: Partial<Organization> = {}): Organization => ({
  id: "o9",
  name: "Fresh Agency",
  slug: "fresh",
  type: "agency",
  org_role: "owner",
  ...over,
});
const field = (host: ParentNode, name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
function fill(host: ParentNode, name: string, value: string) {
  const input = field(host, name);
  if (!input) throw new Error(`the page has no input named "${name}"`);
  type(input, value);
}
const choose = (host: ParentNode, label: string) =>
  click(byText<HTMLElement>(host, "label", label).querySelector("input") as HTMLElement);
const posts = (stub: ReturnType<typeof stubApi>, path: string) =>
  stub.mock.calls.filter(([url, init]) => url === path && init?.method === "POST");
const bodyOf = (call: readonly [string, (RequestInit | undefined)?] | undefined) =>
  JSON.parse(String(call?.[1]?.body));
const keyOf = (call: readonly [string, (RequestInit | undefined)?] | undefined) =>
  new Headers(call?.[1]?.headers).get("Idempotency-Key");
const ORGS_PATH = "/api/v1/organizations";
const WORKSPACES_PATH = "/api/v1/workspaces";

describe("what the start page opens", () => {
  it("a person with no organization and no workspace gets the whole flow", async () => {
    stubApi(lists([]));
    const { host } = await openApp("/");
    for (const name of ["organization", "workspace"]) expect(field(host, name)).not.toBeNull();
    expect(host.textContent).toContain("Time zone");
    expect(byText(host, "button", "Create")).toBeDefined();
  });

  it.each([
    ["an owner", owned()],
    ["an admin", owned({ org_role: "admin" })],
  ])("%s of an organization with no workspace resumes with the workspace only", async (_name, org) => {
    stubApi(lists([org]));
    const { host } = await openApp("/");
    expect(host.textContent).toContain("Fresh Agency");
    expect(field(host, "organization")).toBeNull();
    expect(field(host, "workspace")).not.toBeNull();
  });

  it("a member of an organization with no workspace, or who left the last one, is told to ask an admin and may start their own", async () => {
    stubApi(lists([owned({ org_role: "member" })]));
    const { host } = await openApp("/");
    expect(host.textContent).toMatch(/ask an admin/i);
    expect(field(host, "workspace")).toBeNull();
    click(byText(host, "a", "Start your own organization"));
    await settle();
    expect(field(host, "organization")).not.toBeNull();
  });
});

describe("the organization step", () => {
  it.each([
    [
      "Agency",
      "Each client you add gets its own channels, calendar and approvals.",
      "Name of your first client",
    ],
    [
      "Team",
      "Your team works together in one workspace with shared channels and approvals.",
      "Name of your first workspace",
    ],
    ["Just me", "Just you: one workspace and no switchers.", "Name of your workspace"],
  ])(
    "the type %s shows its own helper text and names the first workspace for it",
    async (label, helper, name) => {
      stubApi(lists([]));
      const { host } = await openApp("/");
      choose(host, label);
      expect(host.textContent).toContain(helper);
      expect(host.textContent).toContain(name);
    },
  );

  it("the first workspace starts as the organization's name until it is edited", async () => {
    stubApi(lists([]));
    const { host } = await openApp("/");
    fill(host, "organization", "Acme");
    expect(field(host, "workspace")?.value).toBe("Acme");
    fill(host, "workspace", "Acme Client");
    fill(host, "organization", "Acme Group");
    expect(field(host, "workspace")?.value).toBe("Acme Client");
  });

  it.each([
    ["an empty name", "", null, "organization"],
    ["a name of spaces only", "   ", null, "organization"],
    ["a workspace typed and the organization empty", "", "Acme Client", "organization"],
    ["an organization typed and the workspace emptied", "Acme", "", "workspace"],
  ])("%s sends nothing and says why", async (_name, orgName, workspaceName, emptied) => {
    const stub = stubApi(lists([]));
    const { host } = await openApp("/");
    fill(host, "organization", orgName);
    if (workspaceName !== null) fill(host, "workspace", workspaceName);
    click(byText(host, "button", "Create"));
    await settle();
    expect(posts(stub, ORGS_PATH)).toHaveLength(0);
    expect(host.textContent).toMatch(/enter a name/i);
    expect(document.activeElement).toBe(field(host, emptied));
    fill(host, emptied, "Fixed");
    expect(host.textContent).not.toMatch(/enter a name/i);
  });
});

describe("creating the organization and its first workspace", () => {
  async function submit(api: Parameters<typeof stubApi>[0] = {}, type_ = "Agency") {
    const stub = stubApi({ ...lists([]), ...api });
    const opened = await openApp("/");
    fill(opened.host, "organization", "Acme");
    choose(opened.host, type_);
    click(byText(opened.host, "button", "Create"));
    await settle();
    return { ...opened, stub };
  }

  it("creates the organization, then the workspace in it with the chosen zone, and opens the workspace", async () => {
    const { stub, router } = await submit();
    expect(bodyOf(posts(stub, ORGS_PATH)[0])).toEqual({ name: "Acme", type: "agency" });
    expect(bodyOf(posts(stub, WORKSPACES_PATH)[0])).toMatchObject({
      organization_id: NEW_ORG,
      name: "Acme",
      default_tz: expect.any(String),
    });
    expect(router.state.location.pathname).toBe(`/w/${NEW_WORKSPACE}`);
  });

  it("Just me creates a personal organization", async () => {
    const { stub } = await submit({}, "Just me");
    expect(bodyOf(posts(stub, ORGS_PATH)[0])).toMatchObject({ type: "personal" });
  });

  it("a failed first-workspace call keeps the organization: the retry sends only the workspace", async () => {
    let calls = 0;
    const { stub, host } = await submit({
      createOrganization: () =>
        json({ data: { id: NEW_ORG, name: "Acme", slug: "acme", type: "agency" } }, 201),
      createWorkspace: () =>
        ++calls === 1
          ? refusal("service_unavailable", 503)
          : json({ data: { id: NEW_WORKSPACE, organization_id: NEW_ORG, name: "Acme", slug: "acme" } }, 201),
    });
    expect(posts(stub, WORKSPACES_PATH)).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(field(host, "organization")).toBeNull();
    click(byText(host, "button", "Create"));
    await settle();
    expect(posts(stub, ORGS_PATH)).toHaveLength(1);
    const orgs = posts(stub, WORKSPACES_PATH).map((call) => bodyOf(call).organization_id);
    expect(orgs).toEqual([NEW_ORG, NEW_ORG]);
    const [first, retry] = posts(stub, WORKSPACES_PATH).map(keyOf);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry).toBe(first);
    expect(keyOf(posts(stub, ORGS_PATH)[0])).not.toBe(first);
  });
});

describe("the organization and workspace calls that fail or repeat", () => {
  async function submit(api: Parameters<typeof stubApi>[0] = {}) {
    const stub = stubApi({ ...lists([]), ...api });
    const opened = await openApp("/");
    fill(opened.host, "organization", "Acme");
    click(byText(opened.host, "button", "Create"));
    await settle();
    return { ...opened, stub };
  }

  it("a reopen at ?new after a failed workspace call resumes the organization: no second one", async () => {
    let made = false;
    const stub = stubApi({
      organizations: () => page(made ? [owned({ id: NEW_ORG, name: "Acme" })] : [])(),
      workspaces: page([]),
      createOrganization: () => {
        made = true;
        return json({ data: { id: NEW_ORG, name: "Acme", slug: "o-new", type: "agency" } }, 201);
      },
      createWorkspace: () => refusal("service_unavailable", 503),
    });
    const { host, router } = await openApp("/");
    fill(host, "organization", "Acme");
    click(byText(host, "button", "Create"));
    await settle();
    await act(async () => void (await router.navigate("/account/profile")));
    await act(async () => void (await router.navigate("/?new=1")));
    expect(field(host, "organization")).toBeNull();
    click(byText(host, "button", "Create"));
    await settle();
    expect(posts(stub, ORGS_PATH)).toHaveLength(1);
    const sent = posts(stub, WORKSPACES_PATH).map((call) => bodyOf(call).organization_id);
    expect(sent).toEqual([NEW_ORG, NEW_ORG]);
  });

  it("a failed organization call keeps what was typed", async () => {
    const { host } = await submit({ createOrganization: () => refusal("service_unavailable", 503) });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(field(host, "organization")?.value).toBe("Acme");
  });

  it.each([
    ["the organization", { createOrganization: () => refusal("unauthenticated", 401) }],
    ["the workspace", { createWorkspace: () => refusal("unauthenticated", 401) }],
  ])("an ended session on the call for %s sends the visitor to sign in", async (_name, api) => {
    const { router } = await submit(api);
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(new URLSearchParams(router.state.location.search).get("return-to")).toBe("/");
  });

  it("a second press while the call is pending sends one POST", async () => {
    const { stub, host } = await submit({ createOrganization: () => new Promise<Response>(() => undefined) });
    click(byText(host, "button", "Create"));
    await settle();
    expect(posts(stub, ORGS_PATH)).toHaveLength(1);
  });
});
