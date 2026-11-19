import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeApp, mount } from "../../test/support/app";
import { EmptyState } from "./empty-state";

afterEach(closeApp);

// ux-spec 2.1 E: first-use has one primary action, filtered-out offers Clear filters, cleared has no action.
describe("EmptyState", () => {
  it.each([
    ["first-use", ["Create a workspace"]],
    ["filtered-out", ["Clear filters"]],
    ["cleared", []],
  ] as const)("the %s kind shows the buttons %j", (kind, expected) => {
    const onPress = vi.fn();
    const host = mount(
      <EmptyState
        kind={kind}
        title="Nothing here"
        {...(kind === "first-use" ? { action: { label: "Create a workspace", onPress } } : {})}
        {...(kind === "filtered-out" ? { onClearFilters: onPress } : {})}
      />,
    );
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(expected);
    if (expected.length > 0) {
      act(() => host.querySelector("button")?.click());
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  });
});
