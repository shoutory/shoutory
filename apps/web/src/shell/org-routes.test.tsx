import { afterEach, describe, expect, it } from "vitest";
import {
  byText,
  closeApp,
  type Organization,
  openApp,
  pageOf as page,
  stubApi,
  WORKSPACES,
} from "../../test/support/app";

afterEach(closeApp);

const PERSONAL: Organization = { id: "o1", name: "Me", slug: "me", type: "personal", org_role: "owner" };
const personal = {
  organizations: page([PERSONAL]),
  workspaces: page(WORKSPACES.slice(0, 1).map((w) => ({ ...w, organization_type: "personal" }))),
};
// A member of one workspace only: its organization is not in their organization list.
const workspaceOnly = {
  organizations: page([]),
  workspaces: page([{ ...WORKSPACES[0], role: "editor", organization_type: "team" }]),
};
const linkTo = (host: ParentNode, href: string) => host.querySelector(`nav a[href="${href}"]`);

describe("the organization and settings routes", () => {
  it.each([
    ["an unknown organization's clients", "/o/zzz/clients", {}],
    ["an unknown organization's billing", "/o/zzz/billing", {}],
    ["an unknown workspace's general settings", "/w/zzz/settings/general", {}],
    ["a personal organization's clients", "/o/o1/clients", personal],
    ["an unknown workspace's members", "/w/zzz/settings/members", {}],
    ["a personal organization's members", "/w/w1/settings/members", personal],
    ["the clients of an organization a workspace-only member is not in", "/o/o1/clients", workspaceOnly],
    ["the billing of an organization a workspace-only member is not in", "/o/o1/billing", workspaceOnly],
  ])("%s open the not-found page and make no call", async (_name, path, api) => {
    const stub = stubApi(api);
    const { host } = await openApp(path);
    expect(host.querySelector("h1")?.textContent).toBe("Page not found");
    const detail = /\/api\/v1\/(workspaces|organizations)\/[^/?]/;
    expect(stub.mock.calls.filter(([url]) => detail.test(url))).toEqual([]);
  });
});

describe("the rail", () => {
  it.each([
    ["an agency workspace shows Clients, Billing, Members and Settings", {}, true, true],
    ["a personal organization keeps only Settings", personal, false, false],
    ["a workspace-only member keeps Members but no organization links", workspaceOnly, false, true],
  ])("%s", async (_name, api, org, members) => {
    stubApi(api);
    const { host } = await openApp("/w/w1");
    expect(linkTo(host, "/w/w1/settings/general")?.textContent).toBe("Settings");
    expect(linkTo(host, "/o/o1/clients")?.textContent ?? null).toBe(org ? "Clients" : null);
    expect(linkTo(host, "/o/o1/billing")?.textContent ?? null).toBe(org ? "Billing" : null);
    expect(linkTo(host, "/w/w1/settings/members")?.textContent ?? null).toBe(members ? "Members" : null);
  });
});

describe("a member of one workspace only", () => {
  it("opens Members with the permission note and Leave, not the not-found page", async () => {
    stubApi(workspaceOnly);
    const { host } = await openApp("/w/w1/settings/members");
    expect(host.querySelector("h1")?.textContent).toBe("Members");
    expect(host.textContent).toMatch(/need the admin role/i);
    expect(byText(host, "button", "Leave workspace")).toBeTruthy();
  });
});
