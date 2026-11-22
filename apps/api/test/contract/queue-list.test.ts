import { createRegistry } from "@shoutory/provider-sdk/registry";
import { fixtureManifest } from "@shoutory/testkit/fixture-provider/manifest";
import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "../global-setup.js";

describe("the queues the test database is installed with", () => {
  it("are the provider queues of the fixture registry", () => {
    // fails first because: the setup installs a list of its own that the registry has drifted from
    expect([...QUEUE_NAMES].sort()).toEqual(createRegistry([fixtureManifest]).allQueueNames().sort());
  });
});
