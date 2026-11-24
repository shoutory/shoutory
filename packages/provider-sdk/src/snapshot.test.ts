import { describe, expect, it } from "vitest";
import { fixtureManifest } from "../test/fixture-manifest.js";
import { type Manifest, manifestSchema } from "./manifest/manifest.js";
import { pastSunset, snapshotOf } from "./snapshot.js";

const NOW = new Date("2026-11-21T00:00:00Z");
const version = (name: string, introduced: string, sunset?: string) => ({
  version: name,
  introduced,
  ...(sunset === undefined ? {} : { sunset }),
  docsUrl: `https://docs.fixture.example/api/${name}`,
  checked: "2026-11-21",
});
const manifestWith = (overrides: Record<string, unknown> = {}): Manifest =>
  manifestSchema.parse(fixtureManifest(overrides));

describe("snapshotOf", () => {
  it("gives a 64-hex digest that changes when a limit changes", () => {
    const base = fixtureManifest();
    const limits = base.limits as Record<string, { value: number }>;
    const changed = {
      ...base,
      limits: { ...limits, textLength: { ...limits.textLength, value: (limits.textLength?.value ?? 0) + 1 } },
    };
    const digest = snapshotOf(manifestSchema.parse(base), NOW).manifestDigest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotOf(manifestSchema.parse(changed), NOW).manifestDigest).not.toBe(digest);
  });

  it("names the newest API version that has not sunset, with its sunset date", () => {
    const manifest = manifestWith({
      apiVersions: [
        version("v1", "2026-01-01"),
        version("v2", "2026-06-01", "2026-12-01"),
        version("v3", "2026-08-01", "2026-10-01"),
      ],
    });
    expect(snapshotOf(manifest, NOW)).toMatchObject({
      apiVersion: "v2",
      sunsetAt: new Date("2026-12-01T00:00:00Z"),
    });
  });

  it("has no sunset for a version that announced none", () => {
    expect(snapshotOf(manifestWith({ apiVersions: [version("v1", "2026-01-01")] }), NOW)).toMatchObject({
      apiVersion: "v1",
      sunsetAt: null,
    });
  });
});

describe("pastSunset", () => {
  // NOW is 2026-11-21 00:00 UTC: a sunset takes effect at the start of its date. [what is announced, past or not]
  const ROWS: [string, Record<string, unknown>, boolean][] = [
    ["a version that sunsets tomorrow", { apiVersions: [version("v1", "2026-01-01", "2026-11-22")] }, false],
    [
      "a version whose sunset date is today",
      { apiVersions: [version("v1", "2026-01-01", "2026-11-21")] },
      true,
    ],
    ["a version that sunset yesterday", { apiVersions: [version("v1", "2026-01-01", "2026-11-20")] }, true],
    ["no sunset announced", { apiVersions: [version("v1", "2026-01-01")] }, false],
    [
      "every version past its sunset",
      { apiVersions: [version("v1", "2026-01-01", "2026-06-01"), version("v2", "2026-03-01", "2026-10-01")] },
      true,
    ],
    [
      "a newer version live beside a retired one",
      { apiVersions: [version("v1", "2026-01-01", "2026-06-01"), version("v2", "2026-09-01")] },
      false,
    ],
    [
      "the whole provider retired",
      { apiVersions: [version("v1", "2026-01-01")], sunset: "2026-11-01" },
      true,
    ],
    [
      "the whole provider retiring later",
      { apiVersions: [version("v1", "2026-01-01")], sunset: "2026-12-01" },
      false,
    ],
  ];
  it.each(ROWS)("%s", (_name, overrides, past) => {
    expect(pastSunset(manifestWith(overrides), NOW)).toBe(past);
  });
});
