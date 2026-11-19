import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");

// Tailwind utilities that name a physical side. `ml-2` needs its value; `text-left` and `border-r` stand alone.
const WITH_VALUE = "(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[\\w./\\[\\]%-]+";
const STANDING =
  "(?:text-left|text-right|float-left|float-right|clear-left|clear-right|(?:border|rounded)-(?:l|r|tl|tr|bl|br)(?:-[\\w./\\[\\]%-]+)?)";
const PATTERNS = [
  new RegExp(`(?<![\\w.-])-?(?:[\\w-]+:)*(?:${WITH_VALUE}|${STANDING})(?![\\w-])`),
  /\b(?:margin|padding|border)-(?:left|right)\b/,
  /\bborder-(?:top|bottom)-(?:left|right)-radius\b/,
  /(?<![\w-])(?:left|right)\s*:/,
  /\b(?:text-align|textAlign|float|clear)\s*:\s*["']?(?:left|right)\b/,
  /\b(?:margin|padding|border)(?:Left|Right)\b/,
  /\bborder(?:Top|Bottom)(?:Left|Right)Radius\b/,
];
// The one allowed exception names its reason: `/* physical: video transport controls */`.
const EXEMPT = /(?:\/\*|\/\/)\s*physical:\s*\S+/;

function findPhysical(text: string) {
  const lines = text.split("\n");
  return lines.flatMap((line, at) => {
    if (EXEMPT.test(line) || EXEMPT.test(lines[at - 1] ?? "")) return [];
    return PATTERNS.some((pattern) => pattern.test(line)) ? [`line ${at + 1}: ${line.trim()}`] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(css|js|ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("logical CSS only", () => {
  it("no physical CSS properties or utilities in apps/web/src", () => {
    const files = sourceFiles(src);
    expect(files.length >= 1).toBe(true);
    const offenders = files.flatMap((file) =>
      findPhysical(readFileSync(file, "utf8")).map((hit) => `${file}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ["a margin utility", '<div className="ml-2" />'],
    ["a prefixed negative utility", '<div className="md:-mr-4" />'],
    ["a standing text utility", '<p className="text-left">x</p>'],
    ["a rounded corner utility", '<i className="rounded-l-lg" />'],
    ["an offset utility", '<i className="absolute left-0" />'],
    ["an offset property", ".a { left: 0; }"],
    ["a margin property", ".a { margin-left: 4px; }"],
    ["a text alignment", ".a { text-align: right; }"],
    ["a physical corner radius", ".a { border-top-left-radius: 4px; }"],
    ["a camel-case margin key", "const s = { marginLeft: 4 };"],
    ["a camel-case text alignment", 'const s = { textAlign: "left" };'],
    ["a camel-case float", 'const s = { float: "right" };'],
    ["a camel-case clear", "const s = { clear: 'left' };"],
    ["a camel-case corner radius", "const s = { borderTopLeftRadius: 4 };"],
    ["an exemption without a reason", "/* physical */\n.a { left: 0; }"],
  ])("the scan finds %s", (_label, text) => {
    expect(findPhysical(text)).toHaveLength(1);
  });

  it.each([
    ["logical utilities", '<div className="ms-2 pe-4 text-start start-0 border-s rounded-s-lg" />'],
    ["logical properties", ".a { margin-inline-start: 4px; inset-inline-start: 0; text-align: start; }"],
    ["an exemption on the line", ".a { left: 0; } /* physical: video transport controls */"],
    [
      "an exemption on the line before",
      "/* physical: chart time axis runs left to right */\n.a { left: 0; }",
    ],
  ])("the scan accepts %s", (_label, text) => {
    expect(findPhysical(text)).toEqual([]);
  });
});
