import { describe, expect, it } from "vitest";
import { findNearSunsets } from "../../src/sunset.js";
import { fixtureManifest } from "../fixture-manifest.js";

const TODAY = new Date("2026-11-21T10:00:00Z");
const DAY_MS = 86_400_000;

// A manifest whose only pinned version retires `days` days after TODAY (a negative number is already past).
function sunsetsIn(days: number) {
  const sunset = new Date(TODAY.getTime() + days * DAY_MS).toISOString().slice(0, 10);
  return fixtureManifest({
    apiVersions: [
      {
        version: "v1",
        introduced: "2025-01-01",
        sunset,
        docsUrl: "https://docs.fixture.example/api/v1",
        checked: "2026-11-21",
      },
    ],
  });
}

describe("apiVersions sunset guard", () => {
  it.each([
    [59, true],
    [60, true],
    [61, false],
    [-1, true],
  ])("a sunset in %d days is flagged: %s", (days, flagged) => {
    expect(findNearSunsets([sunsetsIn(days)], TODAY)).toHaveLength(flagged ? 1 : 0);
  });

  it.each([
    [59, true],
    [61, false],
  ])("a manifest-level sunset in %d days is flagged: %s", (days, flagged) => {
    const sunset = new Date(TODAY.getTime() + days * DAY_MS).toISOString().slice(0, 10);
    const found = findNearSunsets([fixtureManifest({ sunset })], TODAY);
    expect(found.map(({ providerId, daysLeft }) => ({ providerId, daysLeft }))).toEqual(
      flagged ? [{ providerId: "fixture", daysLeft: days }] : [],
    );
  });

  it("names the provider, version, date and days left", () => {
    expect(findNearSunsets([sunsetsIn(59)], TODAY)).toEqual([
      {
        providerId: "fixture",
        version: "v1",
        sunset: new Date(TODAY.getTime() + 59 * DAY_MS).toISOString().slice(0, 10),
        daysLeft: 59,
      },
    ]);
  });

  it("passes for an empty registry and for a version with no sunset", () => {
    const open = fixtureManifest({
      apiVersions: [
        {
          version: "v1",
          introduced: "2025-01-01",
          docsUrl: "https://docs.fixture.example/",
          checked: "2026-11-21",
        },
      ],
    });
    expect(findNearSunsets([], TODAY)).toEqual([]);
    expect(findNearSunsets([open], TODAY)).toEqual([]);
  });
});
