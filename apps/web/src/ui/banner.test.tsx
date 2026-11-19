import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Banner } from "./banner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => document.body.replaceChildren());

// WI-F12: an alert role is for urgent errors; a notice is a status. The text carries the meaning, not the colour.
describe("Banner", () => {
  it.each([
    ["info", "status"],
    ["attention", "status"],
    ["danger", "alert"],
  ] as const)("a %s banner has the role %s and shows its text", (tone, role) => {
    const host = document.body.appendChild(document.createElement("div"));
    act(() => createRoot(host).render(<Banner tone={tone}>Words that explain</Banner>));
    const banner = host.firstElementChild;
    expect(banner?.getAttribute("role")).toBe(role);
    expect(banner?.textContent).toContain("Words that explain");
  });
});
