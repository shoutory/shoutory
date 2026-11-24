import { findNearSunsets } from "@shoutory/provider-sdk/sunset";
import { describe, expect, it } from "vitest";
import { builtInManifests } from "../../src/index.js";

describe("the built-in providers", () => {
  it("finds no built-in provider within 60 days of the real day", () => {
    expect(findNearSunsets(builtInManifests, new Date())).toEqual([]);
  });
});
