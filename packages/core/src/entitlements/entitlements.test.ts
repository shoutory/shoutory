import { describe, expect, it } from "vitest";
import { ENTITLEMENT_KEYS, entitlements } from "./entitlements.js";

describe("the entitlement keys", () => {
  it("are exactly workspaces and members, and self-host leaves each unlimited", async () => {
    expect(ENTITLEMENT_KEYS).toEqual(["workspaces", "members"]);
    for (const key of ENTITLEMENT_KEYS) {
      expect(await entitlements.check("ws-entitlement-keys-1", key)).toEqual({ kind: "unlimited" });
    }
  });
});

describe("entitlements.check on self-host", () => {
  it.each(["posts", "channels", "members", "ai_credits", "an-unknown-key"])(
    "returns unlimited for the key %s",
    async (key) => {
      expect(await entitlements.check("ws-entitlements-1", key)).toEqual({ kind: "unlimited" });
    },
  );
});
