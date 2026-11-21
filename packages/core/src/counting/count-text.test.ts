import { describe, expect, it } from "vitest";
import { type CountingRule, countingRuleSchema, countText } from "./count-text.js";

// Counts worked out by hand from the Unicode data, never produced by the counter. Every invisible, combining or
// astral character is written as an escape. Columns: text, UTF-16 code units, graphemes, UTF-8 bytes.
const UNIT_VECTORS: [string, string, number, number, number][] = [
  ["ascii", "hello", 5, 5, 5],
  ["empty", "", 0, 0, 0],
  // meem+damma, hah+fatha, meem+shadda+fatha, dal
  ["arabic diacritics", "\u{645}\u{64F}\u{62D}\u{64E}\u{645}\u{651}\u{64E}\u{62F}", 8, 4, 16],
  // kaf, two tatweel, teh: tatweel is a letter, not a mark
  ["arabic tatweel", "\u{643}\u{640}\u{640}\u{62A}", 4, 4, 8],
  [
    "arabic then latin then a link",
    "abc \u{645}\u{631}\u{62D}\u{628}\u{627} https://example.com/x",
    31,
    31,
    36,
  ],
  ["cyrillic", "\u{41F}\u{440}\u{438}\u{432}\u{435}\u{442}", 6, 6, 12],
  // ka, virama, ssa: one conjunct since Unicode 15.1 (rule GB9c)
  ["indic conjunct", "\u{915}\u{94D}\u{937}", 3, 1, 9],
  ["cjk basic plane", "\u{4F60}\u{597D}", 2, 2, 6],
  ["astral letters", "\u{20BB7}\u{1D400}", 4, 2, 8],
  ["emoji zwj family", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", 11, 1, 25],
  ["emoji flag", "\u{1F1FA}\u{1F1F8}", 4, 1, 8],
  ["emoji skin tone", "\u{1F44D}\u{1F3FD}", 4, 1, 8],
  ["emoji keycap", "1\u{FE0F}\u{20E3}", 3, 1, 7],
  ["e acute decomposed", "e\u{301}", 2, 1, 3],
  ["e acute precomposed", "\u{E9}", 1, 1, 2],
  ["a ring decomposed", "a\u{30A}", 2, 1, 3],
  ["a ring precomposed", "\u{E5}", 1, 1, 2],
];

describe("countText units", () => {
  it.each(UNIT_VECTORS)(
    "counts graphemes, UTF-16 units and UTF-8 bytes of %s",
    (_id, text, utf16, graphemes, bytes) => {
      expect(countText({ unit: "utf16" }, text)).toBe(utf16);
      expect(countText({ unit: "graphemes" }, text)).toBe(graphemes);
      expect(countText({ unit: "bytes" }, text)).toBe(bytes);
    },
  );
});

// A weighted rule in the shape of a network that charges Latin and punctuation 1 and everything else 2, links 23.
const WEIGHTED_RULE: CountingRule = {
  unit: "weighted",
  urlWeight: 23,
  weights: {
    defaultWeight: 2,
    ranges: [
      { from: 0x0000, to: 0x10ff, weight: 1 },
      { from: 0x2000, to: 0x200d, weight: 1 },
      { from: 0x2010, to: 0x201f, weight: 1 },
      { from: 0x2032, to: 0x2037, weight: 1 },
    ],
  },
};

const WEIGHTED_VECTORS: [string, string, number][] = [
  ["latin", "hello world", 11],
  ["latin with an accent", "caf\u{E9}", 4],
  ["cyrillic", "\u{43F}\u{440}\u{438}\u{432}\u{435}\u{442}", 6],
  ["arabic letters and marks", "\u{645}\u{64E}\u{631}\u{652}\u{62D}\u{64E}\u{628}\u{64B}\u{627}", 9],
  ["cjk", "\u{4F60}\u{597D}", 4],
  ["em dash and prime in the one-weight ranges", "\u{2014}\u{2032}", 2],
  ["ellipsis outside the ranges", "\u{2026}", 2],
  ["astral letter", "\u{20000}", 2],
  ["a link inside text", "see https://example.com/a/b/c now", 31],
  ["a link then a period", "go to https://example.com.", 30],
  ["a link then a comma", "https://example.com/path, ok", 27],
  ["a link in parentheses", "(https://example.com/a)", 25],
  ["a link with a query", "https://example.com/p?a=1&b=2", 23],
  ["two links", "https://one.example.org and https://two.example.org", 51],
  ["arabic then a link", "\u{645}\u{631}\u{62D}\u{628}\u{627} https://example.com", 29],
];

describe("countText URL weight", () => {
  it.each(WEIGHTED_VECTORS)("applies the manifest's weights and URL weight to %s", (_id, text, weighted) => {
    expect(countText(WEIGHTED_RULE, text)).toBe(weighted);
  });

  it("counts a link by its own length when the rule has no URL weight", () => {
    expect(countText({ unit: "graphemes" }, "see https://example.com/a now")).toBe(29);
  });

  it("counts a link by the URL weight under a grapheme rule", () => {
    expect(countText({ unit: "graphemes", urlWeight: 23 }, "see https://example.com/a/b/c/d/e now")).toBe(31);
  });

  it("refuses a weighted rule that has no weights", () => {
    expect(countingRuleSchema.safeParse({ unit: "weighted" }).success).toBe(false);
  });

  it.each([
    ["a range that ends before it starts", [{ from: 5, to: 1, weight: 1 }], false],
    [
      "overlapping ranges",
      [
        { from: 0, to: 10, weight: 1 },
        { from: 5, to: 20, weight: 1 },
      ],
      false,
    ],
    [
      "ranges out of order",
      [
        { from: 20, to: 30, weight: 1 },
        { from: 0, to: 10, weight: 1 },
      ],
      false,
    ],
    [
      "ascending ranges, one a single code point",
      [
        { from: 0, to: 10, weight: 1 },
        { from: 11, to: 11, weight: 1 },
      ],
      true,
    ],
  ])("weight ranges: %s", (_title, ranges, accepted) => {
    const rule = { unit: "weighted", weights: { defaultWeight: 2, ranges } };
    expect(countingRuleSchema.safeParse(rule).success).toBe(accepted);
  });
});
