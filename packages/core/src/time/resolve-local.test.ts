import { describe, expect, it } from "vitest";
import { type Resolution, type ResolvePolicy, resolveLocal } from "./resolve-local.js";

// Each row was worked out by hand from the zone's offsets that day.
describe("resolveLocal automatic", () => {
  const ROWS: [string, string, string, string, Resolution][] = [
    [
      "a New York gap shifts forward by the gap",
      "2027-03-14T02:30",
      "America/New_York",
      "2027-03-14T07:30:00Z",
      "gap_shifted",
    ],
    [
      "the minute after a New York gap",
      "2027-03-14T03:00",
      "America/New_York",
      "2027-03-14T07:00:00Z",
      "unique",
    ],
    [
      "the minute after a New York fold",
      "2027-11-07T02:00",
      "America/New_York",
      "2027-11-07T07:00:00Z",
      "unique",
    ],
    ["a skipped day in Apia", "2011-12-30T12:00", "Pacific/Apia", "2011-12-30T22:00:00Z", "gap_shifted"],
    [
      "a New York fold takes the earlier time",
      "2027-11-07T01:30",
      "America/New_York",
      "2027-11-07T05:30:00Z",
      "fold_earlier",
    ],
    [
      "a unique time with seconds",
      "2027-06-15T09:00:30",
      "America/New_York",
      "2027-06-15T13:00:30Z",
      "unique",
    ],
    ["midnight in Tokyo", "2027-01-01T00:00", "Asia/Tokyo", "2026-12-31T15:00:00Z", "unique"],
  ];
  it.each(ROWS)("%s", (_what, local, zone, instant, resolution) => {
    expect(resolveLocal(local, zone, "automatic")).toEqual({ ok: true, instant, resolution });
  });
});

describe("resolveLocal user policy", () => {
  const NY = "America/New_York";
  const ROWS: [string, string, "earlier" | "later" | null | undefined, object][] = [
    ["a gap is refused", "2027-03-14T02:30", "earlier", { ok: false, code: "local_time_nonexistent" }],
    ["a fold needs a choice", "2027-11-07T01:30", null, { ok: false, code: "local_time_ambiguous" }],
    [
      "a fold with no choice made at all",
      "2027-11-07T01:30",
      undefined,
      { ok: false, code: "local_time_ambiguous" },
    ],
    [
      "a fold with the earlier choice",
      "2027-11-07T01:30",
      "earlier",
      { ok: true, instant: "2027-11-07T05:30:00Z", resolution: "fold_earlier" },
    ],
    [
      "a fold with the later choice",
      "2027-11-07T01:30",
      "later",
      { ok: true, instant: "2027-11-07T06:30:00Z", resolution: "fold_later" },
    ],
    [
      "a unique time needs no choice",
      "2027-06-15T09:00",
      null,
      { ok: true, instant: "2027-06-15T13:00:00Z", resolution: "unique" },
    ],
  ];
  it.each(ROWS)("%s", (_what, local, choice, expected) => {
    expect(resolveLocal(local, NY, { user: choice } as ResolvePolicy)).toEqual(expected);
  });
});

describe("resolveLocal refusals", () => {
  const ROWS: [string, string, string, string][] = [
    ["an unknown zone", "2027-03-14T10:00", "Mars/Base", "invalid_zone"],
    ["an empty zone", "2027-03-14T10:00", "", "invalid_zone"],
    ["an offset in place of a zone", "2027-03-14T10:00", "+05:00", "invalid_zone"],
    ["an over-long zone", "2027-03-14T10:00", "x".repeat(65), "invalid_zone"],
    ["a zone spelled in lower case", "2027-03-14T10:00", "america/new_york", "invalid_zone"],
    ["a leap second", "2027-06-30T23:59:60", "UTC", "invalid_local"],
    ["a day that does not exist", "2027-02-30T10:00", "UTC", "invalid_local"],
    ["a date with no time", "2027-03-14", "UTC", "invalid_local"],
    ["an hour of 25", "2027-03-14T25:00", "UTC", "invalid_local"],
    ["a time with a Z", "2027-03-14T02:30Z", "UTC", "invalid_local"],
    ["a time with an offset", "2027-03-14T02:30+01:00", "UTC", "invalid_local"],
    ["an over-long text", "x".repeat(40), "UTC", "invalid_local"],
  ];
  it.each(ROWS)("%s", (_what, local, zone, code) => {
    expect(resolveLocal(local, zone, "automatic")).toEqual({ ok: false, code });
  });
});
