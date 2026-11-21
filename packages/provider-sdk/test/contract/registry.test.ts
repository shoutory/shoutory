import { describe, expect, it } from "vitest";
import { createRegistry } from "../../src/registry.js";
import { fixtureManifest } from "../fixture-manifest.js";

describe("registry queue names", () => {
  it("builds queue names only from manifest ids", () => {
    const registry = createRegistry([
      fixtureManifest({ id: "alpha", displayName: "Display Name One" }),
      fixtureManifest({ id: "beta_2", displayName: "Display Name Two" }),
    ]);
    expect(registry.queueNames("alpha")).toEqual({ publish: "publish.alpha", reconcile: "reconcile.alpha" });
    expect(registry.allQueueNames().sort()).toEqual([
      "publish.alpha",
      "publish.beta_2",
      "reconcile.alpha",
      "reconcile.beta_2",
    ]);
  });

  it("refuses a hostile id", () => {
    expect(() => createRegistry([fixtureManifest({ id: "../x;drop" })])).toThrow(/"id"/);
  });

  it("refuses two manifests with the same id", () => {
    expect(() => createRegistry([fixtureManifest(), fixtureManifest()])).toThrow(/duplicate/i);
  });

  it("refuses a manifest the schema refuses", () => {
    expect(() => createRegistry([fixtureManifest({ apiAccess: "scraping" })])).toThrow(/apiAccess/);
  });

  it("answers no queue for an id that is not registered", () => {
    const registry = createRegistry([fixtureManifest()]);
    expect(() => registry.queueNames("other")).toThrow(/other/);
  });
});
