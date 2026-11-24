import { BlockList, isIP } from "node:net";

const MAPPED_PREFIX = "::ffff:";

// A dual-stack socket reports `::ffff:10.0.0.1` for 10.0.0.1; both spellings are one client.
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

// Follows MDN X-Forwarded-For, "Selecting an IP address". The header is ignored unless the peer is a trusted proxy;
// it is scanned from the right so a spoofed leftmost entry is never the client.
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
      // An entry that is not an IP stops the scan and the peer address is used.
      if (isIP(entry) === 0) return peer;
      if (!isTrusted(entry)) return entry;
    }
    // Every entry is trusted: the leftmost is the client.
    return entries[0] ?? peer;
  };
}
