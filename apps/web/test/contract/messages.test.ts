import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];

// The ids a source file uses: `<Trans id="a.b">` and `t({ id: "a.b", ... })`; an HTML id has no dot and is ignored.
function usedIds(text: string) {
  const found = text.matchAll(/(?:<Trans\b[^>]*?\bid=|\bid:\s*)["']([\w-]+(?:\.[\w-]+)+)["']/g);
  return [...found].map((match) => match[1] ?? "");
}

// A message written without an explicit id (`<Trans>text</Trans>`, t`text`, t("text"), t({ message })) would get a
// generated id that no scan can find, so each of these shapes is itself a finding.
const WITHOUT_ID = [
  /<(?:Trans|Plural)\b(?![^>]*\bid=)/,
  /\b(?:t|msg)`/,
  /\b(?:t|msg)\(\s*["'`]/,
  /\b(?:t|msg)\(\{(?![^}]*\bid:)/,
];
const withoutId = (text: string) => text.split("\n").filter((line) => WITHOUT_ID.some((re) => re.test(line)));

// The messages of a PO catalog, by id; the header entry (empty id) is not a message. A long message continues on
// further quoted lines, which are joined.
function catalog(po: string) {
  const entries = po.matchAll(/^msgid "([^"]+)"\nmsgstr ((?:"(?:[^"\\]|\\.)*"(?:\n|$))+)/gm);
  return new Map(
    [...entries].map(([, id, body]) => [
      id ?? "",
      [...(body ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => part[1]).join(""),
    ]),
  );
}

const missingIn = (ids: Iterable<string>, messages: Map<string, string>) =>
  [...ids].filter((id) => !messages.has(id));

// A plural message lists its forms as `zero {..} one {..}`; Arabic needs all six.
function lackingPluralForms(messages: Map<string, string>) {
  return [...messages].flatMap(([id, text]) => {
    if (!/\{\w+,\s*plural,/.test(text)) return [];
    const absent = PLURAL_FORMS.filter((form) => !new RegExp(`\\b${form}\\s*\\{`).test(text));
    return absent.length > 0 ? [`${id}: ${absent.join(", ")}`] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const read = (locale: string) => catalog(readFileSync(join(src, `messages/${locale}.po`), "utf8"));
const en = read("en");
const ar = read("ar");

describe("message catalogs", () => {
  it("every message id used exists in en and ar catalogs", () => {
    const ids = new Set(sourceFiles(src).flatMap((file) => usedIds(readFileSync(file, "utf8"))));
    expect(ids.size >= 1).toBe(true);
    expect({ en: missingIn(ids, en), ar: missingIn(ids, ar) }).toEqual({ en: [], ar: [] });
  });
});

describe("explicit message ids", () => {
  it("every message in the sources carries an explicit id", () => {
    const lines = sourceFiles(src).flatMap((file) => withoutId(readFileSync(file, "utf8")));
    expect(lines).toEqual([]);
  });

  it.each([
    ["a Trans element", "<Trans>Hello</Trans>"],
    ["a Plural element", '<Plural value={n} one="a" other="b" />'],
    ["a t template", "const s = t`Hello`;"],
    ["a t call with a string", 'const s = t("Hello");'],
    ["a msg call without an id", 'const m = msg({ message: "Hello" });'],
  ])("the id scan finds %s", (_name, text) => {
    expect(withoutId(text)).toHaveLength(1);
  });

  it.each([
    ["a Trans element with an id", '<Trans id="a.b">Hello</Trans>'],
    ["a t call with an id", 't({ id: "a.b", message: "Hello" })'],
  ])("the id scan accepts %s", (_name, text) => {
    expect(withoutId(text)).toEqual([]);
  });
});

describe("catalog contents", () => {
  it("en and ar hold the same ids", () => {
    expect({ notInAr: missingIn(en.keys(), ar), notInEn: missingIn(ar.keys(), en) }).toEqual({
      notInAr: [],
      notInEn: [],
    });
  });

  it("the scan reports an id that a catalog lacks", () => {
    const used = usedIds(
      '<Trans id="a.present" /> {t({ id: "a.missing", message: "x" })} <main id="main" />',
    );
    expect(used).toEqual(["a.present", "a.missing"]);
    expect(missingIn(used, catalog('msgid "a.present"\nmsgstr "x"'))).toEqual(["a.missing"]);
  });

  it("every plural message in the ar catalog carries zero, one, two, few, many and other", () => {
    expect(lackingPluralForms(ar)).toEqual([]);
  });

  it.each([
    [
      "a catalog that lacks few",
      'msgstr "{n, plural, zero {a} one {b} two {c} many {d} other {e}}"',
      ["items: few"],
    ],
    ["a complete catalog", 'msgstr "{n, plural, zero {a} one {b} two {c} few {d} many {e} other {f}}"', []],
    [
      "a message on several lines that lacks few",
      'msgstr ""\n"{n, plural, zero {a} one {b} "\n"two {c} many {d} other {e}}"',
      ["items: few"],
    ],
    [
      "a message on several lines with every form",
      'msgstr ""\n"{n, plural, zero {a} one {b} two {c} "\n"few {d} many {e} other {f}}"',
      [],
    ],
  ])("the plural check on %s", (_name, msgstr, expected) => {
    expect(lackingPluralForms(catalog(`msgid "items"\n${msgstr}`))).toEqual(expected);
  });
});
