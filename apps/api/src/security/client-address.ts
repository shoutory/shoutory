import { BlockList, isIP } from "node:net";

const MAPPED_PREFIX = "::ffff:";

// A dual-stack socket reports `::ffff:10.0.0.1` for 10.0.0.1; both spellings are one client.
function normalise(address: string): string {
  const mapped = address.toLowerCase().startsWith(MAPPED_PREFIX)
    ? address.slice(MAPPED_PREFIX.length)
    : address;
  return isIP(mapped) === 4 ? mapped : address;
}

const WITH_PORT = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/;

// A proxy may append the client's port (`1.2.3.4:5678`, `[2001:db8::1]:443`). A bare address is tried first so that an
// IPv6 address is never read as an address and a port. Anything else, an out-of-range port included, is returned
// unchanged and is not an address.
function withoutPort(entry: string): string {
  if (isIP(entry) > 0) return entry;
  const [, bracketed, plain, port] = WITH_PORT.exec(entry) ?? [];
  const address = bracketed ?? plain;
  if (address === undefined || isIP(address) === 0) return entry;
  if ((plain !== undefined) !== (isIP(address) === 4)) return entry;
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535) ? address : entry;
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
      .map((entry) => normalise(withoutPort(entry)));
    for (const entry of entries.toReversed()) {
      // An entry that is not an IP stops the scan and the peer address is used.
      if (isIP(entry) === 0) return peer;
      if (!isTrusted(entry)) return entry;
    }
    // Every entry is trusted: the leftmost is the client.
    return entries[0] ?? peer;
  };
}
