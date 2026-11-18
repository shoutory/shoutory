import { describe, expect, it } from "vitest";
import { entitlements } from "./entitlements.js";

describe("entitlements.check on self-host", () => {
  it.each(["posts", "channels", "members", "ai_credits", "an-unknown-key"])(
    "returns unlimited for the key %s",
    async (key) => {
      expect(await entitlements.check("ws-entitlements-1", key)).toEqual({ kind: "unlimited" });
    },
  );
});
