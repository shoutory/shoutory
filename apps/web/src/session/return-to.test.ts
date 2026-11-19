import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

// The sign-in page sends the visitor back to `return-to`: only a path on this origin may be followed (R378).
describe("the return-to value", () => {
  it.each([
    ["an absolute URL", "https://evil.example.test/x"],
    ["a protocol-relative URL", "//evil.example.test/x"],
    ["a backslash form", "/\\evil.example.test/x"],
    ["a leading double backslash", "\\\\evil.example.test"],
    ["an encoded slash pair", "/%2f%2fevil.example.test"],
    ["an encoded backslash", "/%5cevil.example.test"],
    ["a tab inside the slashes", "/\t/evil.example.test"],
    ["a script URL", "javascript:alert(1)"],
    ["a path with no leading slash", "evil.example.test"],
    ["an empty value", ""],
  ])("refuses %s and falls back to the start page", (_name, value) => {
    expect(safeReturnTo(value)).toBe("/");
  });

  it("keeps a same-origin path with its query and fragment", () => {
    expect(safeReturnTo("/calendar/2026-11?view=week#top")).toBe("/calendar/2026-11?view=week#top");
  });

  it("treats a missing value as the start page", () => {
    expect(safeReturnTo(null)).toBe("/");
  });
});
