import { BlockList, isIP } from "node:net";

const MAPPED_PREFIX = "::ffff:";

/** `::ffff:10.0.0.1` is the IPv4 address 10.0.0.1 as a dual-stack socket reports it; both spellings are one client. */
function normalise(address: string): string {
  const mapped = address.toLowerCase().startsWith(MAPPED_PREFIX)
    ? address.slice(MAPPED_PREFIX.length)
    : address;
  return isIP(mapped) === 4 ? mapped : address;
}

function trustedList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = "", prefix = ""] = cidr.split("/");
    list.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/**
 * The client address behind trusted reverse proxies (MDN X-Forwarded-For, "Selecting an IP address"), with the
 * trusted list built once for the configuration. The peer is checked first: when it is not a trusted proxy the header
 * is ignored. Otherwise all header lines are joined and scanned from the right, skipping trusted entries; the first
 * untrusted entry is the client. When every entry is trusted the client is the leftmost one. An entry that is not an
 * IP address stops the scan: the peer is used. The answer is always the normalised address.
 */
export function clientAddressResolver(
  trusted: readonly string[],
): (peer: string, forwardedFor: readonly string[]) => string {
  const list = trustedList(trusted);
  const isTrusted = (address: string): boolean => {
    const family = isIP(address);
    return family > 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
  };
  return (rawPeer, forwardedFor) => {
    const peer = normalise(rawPeer);
    if (!isTrusted(peer)) return peer;
    const entries = forwardedFor
      .join(",")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(normalise);
    for (const entry of entries.toReversed()) {
      if (isIP(entry) === 0) return peer;
      if (!isTrusted(entry)) return entry;
    }
    return entries[0] ?? peer;
  };
}
