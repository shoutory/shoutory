import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");

// A control that cannot be used says why and stays focusable: `aria-disabled="true"`, never the native `disabled`
// attribute or React Aria's `isDisabled` prop (NFR-A11Y-05). Tailwind's `disabled:` variant is a class, not an attribute.
const NATIVE_DISABLED = [
  /<[A-Za-z][\w.]*\s[^>]*(?<![\w-])(?:disabled|isDisabled)(?![\w:-])/, // an attribute on a tag
  /(?<![\w-])(?:disabled|isDisabled)(?:\s*=|\s*\/?>|\s*$)/, // an attribute on a line of its own
  /(?<![\w-])(?:disabled|isDisabled):\s/, // a prop in an object
];

// Quoted values and comments are blanked first, so the word in a title, a class string or a comment is not an attribute.
const code = (line: string) => line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""').replace(/\/\/.*$/, "");

const findNativeDisabled = (text: string) =>
  text
    .split("\n")
    .flatMap((line, at) =>
      NATIVE_DISABLED.some((re) => re.test(code(line))) ? [`line ${at + 1}: ${line.trim()}`] : [],
    );

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("controls explain themselves when unavailable", () => {
  it("no native disabled or isDisabled on a control in apps/web/src", () => {
    const files = sourceFiles(src);
    expect(files.length >= 1).toBe(true);
    const offenders = files.flatMap((file) =>
      findNativeDisabled(readFileSync(file, "utf8")).map((hit) => `${file}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ["a bare attribute", "<button disabled>Save</button>"],
    ["an attribute before another", '<button disabled type="button">Save</button>'],
    ["an attribute with a value", "<button disabled={busy}>Save</button>"],
    ["a React Aria prop", "<Button isDisabled>Save</Button>"],
    ["a prop on its own line", "  disabled={saving}"],
    ["a prop in an object", "const props = { disabled: true };"],
  ])("the scan finds %s", (_name, text) => {
    expect(findNativeDisabled(text)).toHaveLength(1);
  });

  it.each([
    ["aria-disabled", '<button aria-disabled="true">Save</button>'],
    ["Tailwind's disabled variant", '<button className="disabled:opacity-50">Save</button>'],
    ["a word in a sentence", "// the save button is shown disabled until the form is valid"],
    ["a comment that ends with the word", "// the save button stays disabled"],
    ["the word inside an attribute value", '<a title="Save is disabled" href="/x">Save</a>'],
    ["the word in element text", "<p>Save is disabled</p>"],
  ])("the scan accepts %s", (_name, text) => {
    expect(findNativeDisabled(text)).toEqual([]);
  });
});
