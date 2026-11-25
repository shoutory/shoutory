import { describe, expect, it } from "vitest";
import { normalizeInstanceHost } from "./host.js";

describe("normalizeInstanceHost", () => {
  it.each([
    ["town.example", "town.example"],
    ["  Town.Example  ", "town.example"],
    ["https://town.example", "town.example"],
    ["HTTPS://town.example/", "town.example"],
    ["https://town.example/@someone?x=1#top", "town.example"],
    ["town.example/about", "town.example"],
    ["town.example.", "town.example"],
    ["town.example:443", "town.example"],
    ["https://town.example:443/", "town.example"],
    ["mäst.example", "xn--mst-qla.example"],
    ["social.example-host.org", "social.example-host.org"],
  ])("%j is the host %s", (input, host) => {
    expect(normalizeInstanceHost(input)).toBe(host);
  });

  it.each([
    ["another scheme", "http://town.example"],
    ["a scheme with no host", "https://"],
    ["userinfo", "https://user:pass@town.example"],
    ["userinfo without a scheme", "user@town.example"],
    ["another port", "town.example:8443"],
    ["an IPv4 literal", "93.184.216.34"],
    ["a numeric host the URL parser reads as IPv4", "0x7f.1"],
    ["an IPv6 literal", "[2001:db8::1]"],
    ["a name with no dot", "localhost"],
    ["an empty value", "   "],
    ["an empty label", "a..example"],
    ["a label over 63 characters", `${"a".repeat(64)}.example`],
    ["a name over 253 characters", `${"a.".repeat(126)}example`],
    ["a character a host may not hold", "to_wn.example"],
    ["a space inside", "to wn.example"],
  ])("refuses %s (%j)", (_name, input) => {
    expect(normalizeInstanceHost(input)).toBeUndefined();
  });
});
