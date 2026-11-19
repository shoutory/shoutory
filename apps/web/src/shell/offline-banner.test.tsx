import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeApp, mount } from "../../test/support/app";
import { OfflineBanner } from "./offline-banner";

afterEach(closeApp);

function render(onLine: boolean) {
  vi.stubGlobal("navigator", { onLine, languages: ["en"] });
  return mount(<OfflineBanner />);
}
const fire = (name: "online" | "offline") => act(() => void window.dispatchEvent(new Event(name)));

// ux-spec 2.1 O: a persistent banner while the browser is offline, only then.
describe("OfflineBanner", () => {
  it.each([
    ["online", true, false],
    ["offline", false, true],
  ])("starts %s: banner shown is %s", (_name, onLine, shown) => {
    const host = render(onLine);
    expect(host.textContent?.includes("You are offline")).toBe(shown);
  });

  it("shows on an offline event and hides on the next online event", () => {
    const host = render(true);
    fire("offline");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("You are offline");
    fire("online");
    expect(host.textContent).not.toContain("You are offline");
  });
});
