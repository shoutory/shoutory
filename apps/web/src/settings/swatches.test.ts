import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SWATCHES } from "./swatches";

// The colours a workspace can take: eight named swatches, each with the colour of its label. A swatch is a boundary
// against the page (3:1, WCAG 1.4.11) and its label is text on the swatch (4.5:1, WCAG 1.4.3), in light and dark.
const tokens = readFileSync(join(import.meta.dirname, "../tokens/tokens.css"), "utf8");
const surface = (block: string | undefined) =>
  /--color-surface:\s*(#[0-9a-f]{6})/.exec(block ?? "")?.[1] ?? "";
const SURFACES = {
  light: surface(/@theme static \{([\s\S]*?)\n\}/.exec(tokens)?.[1]),
  dark: surface(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(tokens)?.[1]),
};

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
const ratio = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
};

describe("the workspace colour swatches", () => {
  it("each have their own colour", () => {
    expect(new Set(SWATCHES.map((swatch) => swatch.colour)).size).toBe(SWATCHES.length);
  });

  it.each(
    SWATCHES.flatMap((swatch) => (["light", "dark"] as const).map((theme) => [swatch, theme] as const)),
  )("%j against the %s surface needs 3:1", ({ colour }, theme) => {
    expect(ratio(colour, SURFACES[theme])).toBeGreaterThanOrEqual(3);
  });

  it.each(SWATCHES)("the label of %j on its swatch needs 4.5:1", ({ colour, label }) => {
    expect(ratio(label, colour)).toBeGreaterThanOrEqual(4.5);
  });
});
