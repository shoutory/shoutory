import { describe, expect, it } from "vitest";
import { ipSubject } from "./throttle.js";

describe("the per-address bucket subject", () => {
  it.each([
    ["an IPv4 address is kept whole", "192.0.2.7", "192.0.2.7"],
    [
      "an IPv6 address becomes its /64 prefix",
      "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
      "2001:0db8:0001:0002::/64",
    ],
    ["a compressed IPv6 address expands first", "2001:db8:1:2::1", "2001:0db8:0001:0002::/64"],
    ["an address that starts compressed", "::1", "0000:0000:0000:0000::/64"],
    ["case does not make a second bucket", "2001:DB8:1:2::9", "2001:0db8:0001:0002::/64"],
  ])("%s", (_name, address, subject) => {
    expect(ipSubject(address)).toBe(subject);
  });

  it("gives two hosts of one /64 one bucket and two /64s two buckets", () => {
    expect(ipSubject("2001:db8:1:2::1")).toBe(ipSubject("2001:db8:1:2:ffff::2"));
    expect(ipSubject("2001:db8:1:2::1")).not.toBe(ipSubject("2001:db8:1:3::1"));
  });
});
