import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  json,
  openApp,
  pageOf as page,
  refusal,
  stubApi,
  WORKSPACES,
} from "../../test/support/app";

afterEach(closeApp);

const PATH = "/o/o1/billing";
const entitlementCalls = (stub: ReturnType<typeof stubApi>) =>
  stub.mock.calls.filter(([url]) => url.endsWith("/entitlements"));

describe("the billing and entitlements page", () => {
  it("reads the limits through the organization's first workspace and shows Unlimited, never a zero, for each key", async () => {
    const stub = stubApi();
    const { host } = await openApp(PATH);
    expect(entitlementCalls(stub).map(([url]) => url)).toEqual(["/api/v1/workspaces/w1/entitlements"]);
    expect(host.textContent).toContain("Workspaces");
    expect(host.textContent).toContain("Members");
    expect(host.textContent?.match(/Unlimited/g)).toHaveLength(2);
    expect(host.querySelector("meter")).toBeNull();
  });

  // The route's own `used` is shown: the caller's list holds two of the organization's clients, the plan counts one.
  const limited = () =>
    json({
      data: {
        workspaces: { kind: "limited", limit: 5, used: 1 },
        members: { kind: "limited", limit: 3, used: 0 },
      },
    });

  it("shows a limited key as a meter with the used count the route answers, and a plain limit for members", async () => {
    stubApi({ entitlements: limited });
    const { host } = await openApp(PATH);
    const meters = [...host.querySelectorAll("meter")];
    expect(meters.map((meter) => meter.getAttribute("value"))).toEqual(["1"]);
    expect(meters[0]?.getAttribute("max")).toBe("5");
    expect(host.textContent).toMatch(/members[\s\S]*3/i);
  });

  it.each([
    ["en", "1 of 5", "Up to 3", "latn"],
    ["ar", "١ من ٥", "حتى ٣", "arab"],
  ] as const)(
    "the %s page writes its numbers with the digits setting (%s)",
    async (locale, used, upTo, digits) => {
      localStorage.setItem("shoutory.digits", digits === "arab" ? "arab" : "latn");
      stubApi({ entitlements: limited });
      const { host } = await openApp(PATH, locale);
      expect(host.textContent).toContain(used);
      expect(host.textContent).toContain(upTo);
    },
  );

  it("an organization with no workspace the caller reaches shows an empty state and asks for nothing", async () => {
    const stub = stubApi({
      workspaces: page(WORKSPACES.filter((workspace) => workspace.organization_id !== "o1")),
    });
    const { host } = await openApp(PATH);
    expect(host.querySelector('[data-kind="first-use"]')).not.toBeNull();
    expect(entitlementCalls(stub)).toHaveLength(0);
  });

  it("a failed read shows the error panel with Retry and keeps the frame", async () => {
    stubApi({ entitlements: () => refusal("service_unavailable", 503) });
    const { host } = await openApp(PATH);
    expect(host.querySelector('main [role="alert"]')).not.toBeNull();
    expect(host.querySelector("nav")).not.toBeNull();
  });
});
