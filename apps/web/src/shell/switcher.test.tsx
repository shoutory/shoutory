import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  click,
  closeApp,
  combobox,
  json,
  ORGS,
  type Organization,
  openApp,
  press,
  stubApi,
  WORKSPACES,
  type Workspace,
} from "../../test/support/app";

afterEach(closeApp);

const page = (rows: unknown[]) => () => json({ data: rows, meta: { next_cursor: null } });
const PERSONAL: Organization = { id: "o1", name: "Me", slug: "me", type: "personal" };
const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
const openList = (input: HTMLInputElement) => press(input, "ArrowDown");

const has = (host: Element, name: string) =>
  [...host.querySelectorAll('input[role="combobox"]')].some((input) =>
    (input.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent?.includes(name)),
  );

// ux-spec X-01 and 0.3: a switcher exists only when there is something to choose.
describe("the switchers", () => {
  it.each<[string, Organization[], Workspace[], boolean, boolean]>([
    ["an agency with two workspaces", ORGS, WORKSPACES.slice(0, 2), true, true],
    ["an agency with one workspace", [ORGS[0] as Organization], WORKSPACES.slice(0, 1), true, false],
    [
      "a personal organization with two workspaces",
      [PERSONAL],
      WORKSPACES.slice(0, 2).map((w) => ({ ...w, organization_id: "o1" })),
      false,
      true,
    ],
    ["a personal organization with one workspace", [PERSONAL], WORKSPACES.slice(0, 1), false, false],
  ])("%s", async (_name, orgs, workspaces, orgSwitcher, workspaceSwitcher) => {
    stubApi({ organizations: page(orgs), workspaces: page(workspaces) });
    const { host } = await openApp("/w/w1");
    expect(has(host, "Organization")).toBe(orgSwitcher);
    expect(has(host, "Workspace")).toBe(workspaceSwitcher);
  });

  it("lists the workspaces of the current organization and navigates to /w/:id on choosing one", async () => {
    stubApi();
    const { host, router } = await openApp("/w/w1");
    openList(combobox(host, "Workspace"));
    expect(options()).toEqual(["Acme One", "Acme Two"]);
    click(byText(document.body, '[role="option"]', "Acme Two"));
    expect(router.state.location.pathname).toBe("/w/w2");
  });

  it("choosing another organization only filters the workspace list", async () => {
    stubApi();
    const { host, router } = await openApp("/w/w1");
    openList(combobox(host, "Organization"));
    click(byText(document.body, '[role="option"]', "Beta Team"));
    expect(router.state.location.pathname).toBe("/w/w1");
    openList(combobox(host, "Workspace"));
    expect(options()).toEqual(["Beta Main"]);
  });

  it("the chosen organization follows the current workspace after navigation", async () => {
    stubApi();
    const { host, router } = await openApp("/w/w1");
    openList(combobox(host, "Organization"));
    click(byText(document.body, '[role="option"]', "Beta Team"));
    await act(() => router.navigate("/w/w2"));
    openList(combobox(host, "Workspace"));
    expect(options()).toEqual(["Acme One", "Acme Two"]);
  });
});
