import { describe, expect, it } from "vitest";
import { clientAddressResolver } from "./client-address.js";

const PROXIES = ["10.0.0.0/8", "fd00::/8"];

type Row = [string, string, string[], string[], string];
const ROWS: Row[] = [
  ["an unlisted peer: the header is ignored entirely", "192.0.2.1", ["198.51.100.9"], PROXIES, "192.0.2.1"],
  ["an empty proxy list trusts nobody", "10.0.0.1", ["198.51.100.9"], [], "10.0.0.1"],
  ["no header: the peer", "10.0.0.1", [], PROXIES, "10.0.0.1"],
  [
    "a spoofed leftmost entry is skipped for the rightmost untrusted one",
    "10.0.0.1",
    ["1.1.1.1, 203.0.113.7"],
    PROXIES,
    "203.0.113.7",
  ],
  [
    "two header lines are joined in order before the scan",
    "10.0.0.1",
    ["1.1.1.1", "203.0.113.7, 10.0.0.2"],
    PROXIES,
    "203.0.113.7",
  ],
  ["every entry trusted: the leftmost entry", "10.0.0.1", ["10.0.0.5, 10.0.0.6"], PROXIES, "10.0.0.5"],
  [
    "a malformed entry stops the scan and the peer is used",
    "10.0.0.1",
    ["203.0.113.7, not-an-ip, 10.0.0.2"],
    PROXIES,
    "10.0.0.1",
  ],
  [
    "an untrusted address to the right of a malformed one is still found first",
    "10.0.0.1",
    ["not-an-ip, 203.0.113.7"],
    PROXIES,
    "203.0.113.7",
  ],
  ["an IPv6 proxy and client", "fd00::1", ["2001:db8::5"], PROXIES, "2001:db8::5"],
  [
    "an IPv4-mapped IPv6 peer matches an IPv4 CIDR",
    "::ffff:10.0.0.1",
    ["203.0.113.7"],
    PROXIES,
    "203.0.113.7",
  ],
  [
    "an unlisted IPv4-mapped peer is returned as its IPv4 form",
    "::ffff:192.0.2.1",
    ["198.51.100.9"],
    PROXIES,
    "192.0.2.1",
  ],
  [
    "a client entry in IPv4-mapped form is returned as its IPv4 form",
    "10.0.0.1",
    ["::ffff:203.0.113.7"],
    PROXIES,
    "203.0.113.7",
  ],
  [
    "when every entry is trusted the leftmost is returned in IPv4 form",
    "10.0.0.1",
    ["::ffff:10.0.0.5, 10.0.0.6"],
    PROXIES,
    "10.0.0.5",
  ],
];

describe("client address behind proxies", () => {
  it.each(ROWS)("%s", (_name, peer, lines, proxies, expected) => {
    expect(clientAddressResolver(proxies)(peer, lines)).toBe(expected);
  });
});
