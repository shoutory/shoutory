import { describe, expect, it } from "vitest";
import { adoptRefresh, type ChannelToken, channelTokenSchema } from "./credential.js";

const CURRENT: ChannelToken = {
  access_token: "access-old",
  refresh_token: "refresh-old",
  dpop_private_jwk: { kty: "EC", crv: "P-256", d: "key-old" },
};

describe("the stored channel token", () => {
  it.each([
    ["an access token alone", { access_token: "a" }, true],
    ["an issuer", { access_token: "a", issuer: "https://as.example" }, true],
    ["an issuer that is not https", { access_token: "a", issuer: "http://as.example" }, false],
    ["access, refresh and a DPoP key", CURRENT, true],
    ["an empty access token", { access_token: "" }, false],
    ["no access token", { refresh_token: "r" }, false],
    ["a field the layout does not know", { access_token: "a", scope: "x" }, false],
    ["a refresh token that is not text", { access_token: "a", refresh_token: 7 }, false],
    ["an access token of 8192 characters", { access_token: "a".repeat(8192) }, true],
    ["an access token of 8193 characters", { access_token: "a".repeat(8193) }, false],
    ["a refresh token of 8193 characters", { access_token: "a", refresh_token: "r".repeat(8193) }, false],
    ["a DPoP key over the bound", { access_token: "a", dpop_private_jwk: { d: "k".repeat(8193) } }, false],
  ])("%s: accepted is %s", (_name, value, accepted) => {
    expect(channelTokenSchema.safeParse(value).success).toBe(accepted);
  });
});

describe("what a refresh answer adopts", () => {
  it("adopts nothing when the refresh failed", () => {
    expect(adoptRefresh(CURRENT, undefined)).toBeUndefined();
  });

  it("keeps the old refresh token and the DPoP key when the answer carries no refresh token", () => {
    expect(adoptRefresh(CURRENT, { access_token: "access-new" })).toEqual({
      ...CURRENT,
      access_token: "access-new",
    });
  });

  it("replaces the refresh token when the provider rotated it, and keeps the DPoP key", () => {
    expect(adoptRefresh(CURRENT, { access_token: "access-new", refresh_token: "refresh-new" })).toEqual({
      ...CURRENT,
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("refuses an answer with an empty access token", () => {
    expect(adoptRefresh(CURRENT, { access_token: "" })).toBeUndefined();
  });
});
