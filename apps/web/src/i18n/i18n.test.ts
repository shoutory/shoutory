import { describe, expect, it } from "vitest";
import { applyLocale, detectLocale, formatDate, formatNumber, type Locale } from "./i18n.js";

describe("applyLocale", () => {
  it("Arabic locale sets dir=rtl and lang=ar on the document", () => {
    applyLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  it("English locale sets dir=ltr and lang=en on the document", () => {
    applyLocale("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("detectLocale", () => {
  it.each<[string, string | null, string[], Locale]>([
    ["a stored locale wins", "ar", ["en-US"], "ar"],
    ["the first supported browser language", null, ["fr", "ar-EG", "en"], "ar"],
    ["an unsupported stored value is ignored", "xx", ["ar"], "ar"],
    ["no supported language falls back to English", null, ["fr", "de"], "en"],
  ])("%s", (_name, stored, languages, expected) => {
    expect(detectLocale(stored, languages)).toBe(expected);
  });
});

// Numbering system and calendar are always explicit (V-35): Latin digits by default, Arabic-Indic by setting, and the
// Gregorian calendar whatever the locale's own default. Compact notation is not pinned: its text changes with ICU.
const INSTANT = new Date("2026-11-19T12:00:00Z");

describe("digits and calendar per locale for fixed instants", () => {
  it.each([
    ["en", "latn", "1,234,567.89", "November 19, 2026"],
    ["en", "arab", "١٬٢٣٤٬٥٦٧٫٨٩", "November ١٩, ٢٠٢٦"],
    ["ar", "latn", "1,234,567.89", "19 نوفمبر 2026"],
    ["ar", "arab", "١٬٢٣٤٬٥٦٧٫٨٩", "١٩ نوفمبر ٢٠٢٦"],
  ] as const)("%s with %s digits", (locale, digits, number, date) => {
    const prefs = { locale, digits };
    expect(formatNumber(1234567.89, prefs)).toBe(number);
    expect(formatDate(INSTANT, prefs, "UTC")).toBe(date);
  });

  it("a date is shown in the zone it is given", () => {
    const prefs = { locale: "en", digits: "latn" } as const;
    expect(formatDate(INSTANT, prefs, "Pacific/Chatham")).toBe("November 20, 2026");
  });
});
