import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

function render(element: React.ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root?.render(element));
  const button = host.querySelector("button");
  if (!button) throw new Error("no button rendered");
  return button;
}

const key = (button: HTMLElement, type: "keydown" | "keyup", name: string) =>
  act(() => {
    button.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true }));
  });

describe("the Button while aria-disabled is set", () => {
  it("stays focusable, is not natively disabled and links its reason", () => {
    const button = render(
      <Button aria-disabled reason="Pick a date first" onPress={() => undefined}>
        Save
      </Button>,
    );
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    const reasonId = button.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe("Pick a date first");
  });

  it.each([
    ["a click", (b: HTMLElement) => act(() => b.click())],
    [
      "the Enter key",
      (b: HTMLElement) => {
        key(b, "keydown", "Enter");
        key(b, "keyup", "Enter");
      },
    ],
    [
      "the Space key",
      (b: HTMLElement) => {
        key(b, "keydown", " ");
        key(b, "keyup", " ");
      },
    ],
  ])("%s never calls onPress", (_name, press) => {
    const onPress = vi.fn();
    const button = render(
      <Button aria-disabled reason="Pick a date first" onPress={onPress}>
        Save
      </Button>,
    );
    press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("the Button's handlers", () => {
  it.each(["onPressStart", "onPressEnd", "onPressUp", "onPressChange", "onClick", "onKeyDown", "onKeyUp"])(
    "%s of the caller never runs",
    (name) => {
      const handler = vi.fn();
      const handlers = { [name]: handler };
      const button = render(
        <Button aria-disabled reason="Pick a date first" {...handlers}>
          Save
        </Button>,
      );
      act(() => button.click());
      for (const pressed of ["Enter", " "]) {
        key(button, "keydown", pressed);
        key(button, "keyup", pressed);
      }
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("an available Button calls onPress on a click", () => {
    const onPress = vi.fn();
    const button = render(<Button onPress={onPress}>Save</Button>);
    act(() => button.click());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("the Button's classes", () => {
  it.each([
    ["a class string", "extra-class"],
    ["a class function", () => "extra-class"],
  ])("keeps the base classes with %s", (_name, className) => {
    const button = render(<Button className={className}>Save</Button>);
    expect(button.classList.contains("extra-class")).toBe(true);
    expect(button.classList.contains("rounded-md")).toBe(true);
    expect(button.classList.contains("focus-visible:outline-focus")).toBe(true);
  });
});
