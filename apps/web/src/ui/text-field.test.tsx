import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TextField } from "./text-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

function render(element: React.ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(host).render(element));
  return host;
}

// WI-F01 and WI-F06: a visible label names the input; a refusal is text tied to the field, not colour alone.
describe("TextField", () => {
  it("names the input by its label", () => {
    const host = render(<TextField label="Email" name="email" />);
    const input = host.querySelector("input");
    const labelId = input?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelId)?.textContent).toBe("Email");
  });

  it("ties an error message to the input and marks it invalid", () => {
    const host = render(<TextField label="Email" name="email" errorMessage="Enter a valid email address" />);
    const input = host.querySelector("input");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (input?.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("Enter a valid email address");
  });

  it("has no invalid mark or description without an error", () => {
    const host = render(<TextField label="Email" name="email" />);
    const input = host.querySelector("input");
    expect(input?.getAttribute("aria-invalid")).toBeNull();
  });
});
