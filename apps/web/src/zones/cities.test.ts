import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The zone list is generated at build time from CLDR exemplar cities (Intl does not expose them); this file is its
// drift test: the committed list must name every zone the server accepts, in both languages.
const file = join(import.meta.dirname, "cities.json");
const data = JSON.parse(readFileSync(file, "utf8")) as {
  notice: string;
  zones: Record<string, { en: string; ar: string }>;
};
const NODE_ZONES = Intl.supportedValuesOf("timeZone");

describe("the generated zone list", () => {
  it("names every zone Node supports, in English and Arabic, and no zone it does not know", () => {
    const listed = Object.keys(data.zones);
    expect(NODE_ZONES.filter((zone) => !listed.includes(zone))).toEqual([]);
    expect(listed.filter((zone) => zone !== "UTC" && !NODE_ZONES.includes(zone))).toEqual([]);
    const unnamed = Object.entries(data.zones).filter(([, names]) => !names.en.trim() || !names.ar.trim());
    expect(unnamed.map(([zone]) => zone)).toEqual([]);
  });

  it("takes the city names from CLDR, Cairo in Arabic and a two-word city by its name", () => {
    expect(data.zones["Africa/Cairo"]).toEqual({ en: "Cairo", ar: "القاهرة" });
    expect(data.zones["America/Buenos_Aires"]?.en).toBe("Buenos Aires");
    // UTC has no CLDR exemplar city: it takes its last segment in both languages.
    expect(data.zones.UTC).toEqual({ en: "UTC", ar: "UTC" });
  });

  it("carries the Unicode copyright and licence notice the data's licence asks for", () => {
    expect(data.notice).toMatch(/Copyright/);
    expect(data.notice).toMatch(/Unicode/);
  });
});
