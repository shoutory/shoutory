import { describe, expect, it } from "vitest";
import { cidrContains, isBlockedAddress, isMetadataOrLinkLocal, parseCidr } from "./address.js";

describe("the shared address classifier (NFR-SEC-11)", () => {
  // The fixed refuse list: private, loopback, link-local, CGNAT, ULA, multicast, unspecified, reserved, metadata.
  it.each([
    ["unspecified v4", "0.0.0.0"],
    ["private 10/8", "10.1.2.3"],
    ["CGNAT", "100.64.0.1"],
    ["loopback v4", "127.0.0.1"],
    ["link-local and metadata v4", "169.254.169.254"],
    ["private 172.16/12", "172.16.0.1"],
    ["IETF protocol block", "192.0.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["benchmarking", "198.18.0.1"],
    ["multicast v4", "224.0.0.1"],
    ["reserved 240/4", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["loopback v6", "::1"],
    ["unspecified v6", "::"],
    ["ULA fc00::/7", "fc00::1"],
    ["ULA fd", "fd12:3456::1"],
    ["link-local v6", "fe80::1"],
    ["multicast v6", "ff02::1"],
    ["AWS metadata v6", "fd00:ec2::254"],
    ["mapped loopback, dotted", "::ffff:127.0.0.1"],
    ["mapped loopback, hex", "::ffff:7f00:1"],
    ["mapped private", "::ffff:10.0.0.1"],
    ["mapped metadata", "::ffff:169.254.169.254"],
    ["NAT64 private", "64:ff9b::a00:1"],
    ["IPv4-compatible loopback", "::7f00:1"],
    ["0.0.0.0/8 member", "0.1.2.3"],
    ["6to4 wrapping loopback", "2002:7f00:1::"],
    ["6to4 wrapping private", "2002:a00:1::"],
    ["6to4 wrapping metadata", "2002:a9fe:a9fe::"],
    ["NAT64 wrapping loopback", "64:ff9b::7f00:1"],
    ["NAT64 wrapping metadata", "64:ff9b::a9fe:a9fe"],
    ["site-local multicast v6", "ff05::2"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["NAT64 local-use prefix", "64:ff9b:1::1"],
  ])("refuses %s (%s)", (_name, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "lets the public address %s through",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("the metadata check and the CIDR parser", () => {
  it.each([
    ["169.254.169.254", true],
    ["fe80::1", true],
    ["::ffff:169.254.1.1", true],
    ["fd00:ec2::254", true],
    ["168.63.129.16", true],
    ["100.100.100.200", true],
    ["192.0.0.192", true],
    ["168.63.129.17", false],
    ["10.0.0.1", false],
    ["127.0.0.1", false],
  ])("isMetadataOrLinkLocal(%s) is %s", (address, expected) => {
    expect(isMetadataOrLinkLocal(address)).toBe(expected);
  });

  it("parses a CIDR and tests membership in both families", () => {
    expect(cidrContains(parseCidr("10.0.0.0/8"), "10.200.1.1")).toBe(true);
    expect(cidrContains(parseCidr("10.0.0.0/8"), "11.0.0.1")).toBe(false);
    expect(cidrContains(parseCidr("fd12::/16"), "fd12:1::1")).toBe(true);
    expect(cidrContains(parseCidr("10.0.0.0/8"), "::ffff:10.1.1.1")).toBe(true);
  });

  it.each(["", "10.0.0.0", "10.0.0.0/33", "10.0.0.0/-1", "nope/8", "fd00::/129", "10.0.0.0/8/8"])(
    "refuses the malformed CIDR %j",
    (text) => {
      expect(() => parseCidr(text)).toThrow();
    },
  );
});
