import { afterEach, describe, expect, it } from "vitest";
import {
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
  workspaces: page(WORKSPACES.slice(0, 1).map((w) => ({ ...w, organization_id: "o1" }))),
};
const linkTo = (host: ParentNode, href: string) => host.querySelector(`nav a[href="${href}"]`);

// An id that is none of the caller's, or an organization page of a personal organization, reaches the not-found page
// and no call beyond the two lists.
describe("the organization and settings routes", () => {
  it.each([
    ["an unknown organization's clients", "/o/zzz/clients", {}],
    ["an unknown organization's billing", "/o/zzz/billing", {}],
    ["an unknown workspace's general settings", "/w/zzz/settings/general", {}],
    ["a personal organization's clients", "/o/o1/clients", personal],
    ["an unknown workspace's members", "/w/zzz/settings/members", {}],
    ["a personal organization's members", "/w/w1/settings/members", personal],
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
    ["an agency workspace shows Clients, Billing, Members and Settings", {}, true],
    ["a personal organization keeps only Settings", personal, false],
  ])("%s", async (_name, api, org) => {
    stubApi(api);
    const { host } = await openApp("/w/w1");
    expect(linkTo(host, "/w/w1/settings/general")?.textContent).toBe("Settings");
    expect(linkTo(host, "/o/o1/clients")?.textContent ?? null).toBe(org ? "Clients" : null);
    expect(linkTo(host, "/o/o1/billing")?.textContent ?? null).toBe(org ? "Billing" : null);
    expect(linkTo(host, "/w/w1/settings/members")?.textContent ?? null).toBe(org ? "Members" : null);
  });
});
