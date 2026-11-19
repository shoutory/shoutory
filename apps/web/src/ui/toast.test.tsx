import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastRegion, toasts } from "./toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let open: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root.render(<ToastRegion />));
});

afterEach(() => {
  act(() => {
    for (const key of open) toasts.close(key);
    root.unmount();
  });
  open = [];
  vi.useRealTimers();
  document.body.replaceChildren();
});

const show = (content: Parameters<typeof toasts.show>[0]) => {
  let key = "";
  act(() => {
    key = toasts.show(content);
  });
  open.push(key);
  return key;
};
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const text = () => document.body.textContent ?? "";

// ux-spec 6.5: a toast lasts 6 s, an error stays until closed, hover or focus pauses the clock, and the live region
// announces a success politely and an error assertively (WI-F11, WI-F12, WI-F14; WCAG 2.2.1).
describe("toasts", () => {
  it("a success disappears after 6 s and not before", async () => {
    show({ kind: "success", title: "Saved" });
    expect(text()).toContain("Saved");
    await wait(5_900);
    expect(text()).toContain("Saved");
    await wait(200);
    expect(text()).not.toContain("Saved");
  });

  it("an error stays until it is closed", async () => {
    const key = show({ kind: "error", title: "Could not save" });
    await wait(120_000);
    expect(text()).toContain("Could not save");
    act(() => toasts.close(key));
    expect(text()).not.toContain("Could not save");
  });

  it.each([
    ["success", "status"],
    ["info", "status"],
    ["error", "alert"],
  ] as const)("a %s toast is announced through role %s", (kind, role) => {
    show({ kind, title: "Message" });
    const live = document.querySelector('[aria-atomic="true"]');
    expect(live?.getAttribute("role")).toBe(role);
  });

  it("focus inside a toast pauses its clock until focus leaves", async () => {
    show({ kind: "success", title: "Saved" });
    const toast = document.querySelector<HTMLElement>('[role="alertdialog"]');
    act(() => toast?.focus());
    await wait(30_000);
    expect(text()).toContain("Saved");
    act(() => toast?.blur());
    await wait(6_100);
    expect(text()).not.toContain("Saved");
  });

  it("the pointer over the region pauses the clock until it leaves", async () => {
    show({ kind: "success", title: "Saved" });
    const region = document.querySelector<HTMLElement>('[role="region"]');
    act(() => {
      // React derives enter and leave from over and out, so those are what a browser's pointer produces for it.
      region?.dispatchEvent(new PointerEvent("pointerover", { pointerType: "mouse", bubbles: true }));
    });
    await wait(30_000);
    expect(text()).toContain("Saved");
    act(() => {
      region?.dispatchEvent(new PointerEvent("pointerout", { pointerType: "mouse", bubbles: true }));
    });
    await wait(6_100);
    expect(text()).not.toContain("Saved");
  });
});
