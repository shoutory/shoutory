import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");

type Tokens = Map<string, string>;

function declarations(block: string | undefined): Tokens {
  const found = [...(block ?? "").matchAll(/--([\w-]+):\s*([^;]+);/g)];
  return new Map(found.map(([, name, value]) => [name ?? "", value ?? ""]));
}
const light = declarations(/@theme static \{([\s\S]*?)\n\}/.exec(css)?.[1]);
const darkBlock = /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/.exec(css)?.[1];
const dark: Tokens = new Map([...light, ...declarations(darkBlock)]);
const THEMES = { light, dark };

type Rgb = [number, number, number];
const TINT = /^color-mix\(in srgb, var\(--([\w-]+)\) 12%, var\(--color-surface\)\)$/;

function colour(theme: Tokens, name: string): Rgb {
  const value = theme.get(name) ?? "";
  const tint = TINT.exec(value);
  if (tint) {
    const [status, surface] = [colour(theme, tint[1] ?? ""), colour(theme, "color-surface")];
    return status.map((channel, i) => channel * 0.12 + (surface[i] ?? 0) * 0.88) as Rgb;
  }
  const hex = /^#([0-9a-f]{6})$/.exec(value)?.[1];
  if (!hex) throw new Error(`--${name} is not a hex colour or a 12% tint: ${value}`);
  return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb) {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
}

function contrast(a: Rgb, b: Rgb) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const STATUS = ["success", "attention", "danger", "info"];
const TINTS = [...STATUS, "neutral"];
// [foreground, background, minimum ratio]: 4.5 for text, 3 for a boundary or an icon .
const PAIRS: [string, string, number][] = [
  ...["bg", "surface", "surface-2"].flatMap((bg): [string, string, number][] => [
    ["text", bg, 4.5],
    ["text-muted", bg, 4.5],
  ]),
  ["link", "bg", 4.5],
  ["link", "surface", 4.5],
  ["on-primary", "primary", 4.5],
  ["text", "highlight", 4.5],
  ["on-danger", "danger", 4.5],
  ...STATUS.flatMap((s): [string, string, number][] => [
    [s, "bg", 4.5],
    [s, "surface", 4.5],
  ]),
  ["border-control", "bg", 3],
  ["border-control", "surface", 3],
  ["focus", "bg", 3],
  ["focus", "surface", 3],
  ...TINTS.flatMap((s): [string, string, number][] => [
    ["text", `${s}-bg`, 4.5],
    [s, `${s}-bg`, 3],
  ]),
];

describe("token pairs meet WCAG AA contrast in light and dark", () => {
  it.each(
    (Object.keys(THEMES) as (keyof typeof THEMES)[]).flatMap((theme) =>
      PAIRS.map((pair) => [theme, ...pair] as const),
    ),
  )("%s: --color-%s on --color-%s needs %s", (theme, foreground, background, minimum) => {
    const map = THEMES[theme];
    const ratio = contrast(colour(map, `color-${foreground}`), colour(map, `color-${background}`));
    expect(ratio).toBeGreaterThanOrEqual(minimum);
  });
});
