import { describe, expect, it } from "vitest";
import { fixtureManifest } from "../test/fixture-manifest.js";
import { type Manifest, manifestSchema } from "./manifest/manifest.js";
import { snapshotOf } from "./snapshot.js";

// The capability snapshot a channel records (R542 (7)): a digest of the manifest, the API version in force at `now` and
// when it sunsets, and the capabilities and limits as the manifest lists them. The clock is an input.
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
