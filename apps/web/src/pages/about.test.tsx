import { afterEach, describe, expect, it, vi } from "vitest";
import { byText, click, closeApp, json, openApp, stubApi } from "../../test/support/app";

afterEach(() => {
  closeApp();
  vi.unstubAllEnvs();
});

const REPOSITORY = "https://github.com/shoutory/shoutory";
const sourceLink = (host: ParentNode) =>
  host.querySelector<HTMLAnchorElement>('[data-testid="about-source"]');

describe("the About page", () => {
  it.each([
    ["a release", "", `${REPOSITORY}/tree/v1.2.3`],
    ["a nightly build", "0a1b2c3d", `${REPOSITORY}/tree/0a1b2c3d`],
  ])("on %s, signed out, links the source of the running version", async (_name, commit, href) => {
    vi.stubEnv("SHOUTORY_VERSION", "1.2.3");
    vi.stubEnv("SHOUTORY_SOURCE_COMMIT", commit);
    stubApi({ session: () => json(null) });
    const { host, router } = await openApp("/about");
    expect(router.state.location.pathname).toBe("/about");
    expect(sourceLink(host)?.href).toBe(href);
    expect(host.querySelector('[data-testid="about-version"]')?.textContent).toBe("1.2.3");
  });
});

describe("links to the About page", () => {
  it("the sign-in page links it", async () => {
    stubApi();
    const { host } = await openApp("/sign-in");
    expect(byText(host, "a", "About Shoutory").getAttribute("href")).toBe("/about");
  });

  it("the account menu links it", async () => {
    stubApi();
    const { host } = await openApp("/w/w1");
    click(byText(host, "button", "Account"));
    expect(byText(document.body, "a", "About Shoutory").getAttribute("href")).toBe("/about");
  });
});
