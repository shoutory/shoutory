import { isIP } from "node:net";

export interface Cidr {
  readonly bytes: readonly number[];
  readonly bits: number;
}

type Bytes = readonly number[];

function v6Bytes(text: string): number[] {
  let plain = text;
  if (plain.includes(".")) {
    const cut = plain.lastIndexOf(":");
    const [a = 0, b = 0, c = 0, d = 0] = plain
      .slice(cut + 1)
      .split(".")
      .map(Number);
    plain = `${plain.slice(0, cut + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = plain.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function toBytes(address: string): Bytes | undefined {
  const bare = (address.replace(/^\[|\]$/g, "").split("%")[0] ?? "").trim();
  const family = isIP(bare);
  if (family === 4) return bare.split(".").map(Number);
  return family === 6 ? v6Bytes(bare) : undefined;
}

const zeroTo = (bytes: Bytes, end: number) => bytes.slice(0, end).every((byte) => byte === 0);

// IPv4-mapped, SIIT (RFC 2765), IPv4-compatible, NAT64 (RFC 6052, 64:ff9b::/96) and 6to4 (2002::/16) addresses carry an
// IPv4 address, and the IPv4 rules decide for them.
function embeddedV4(bytes: Bytes): Bytes | undefined {
  const mapped = zeroTo(bytes, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const siit =
    zeroTo(bytes, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0;
  const nat64 =
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (mapped || siit || nat64 || zeroTo(bytes, 12)) return bytes.slice(12);
  return bytes[0] === 0x20 && bytes[1] === 0x02 ? bytes.slice(2, 6) : undefined;
}

const inPrefix = (bytes: Bytes, range: Cidr) => {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.bits; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    if (((bytes[bit >> 3] ?? 0) & mask) !== ((range.bytes[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
};

function parseTable(rows: readonly string[]): Cidr[] {
  return rows.map((row) => {
    const [address = "", bits = "0"] = row.split("/");
    return { bytes: toBytes(address) ?? [], bits: Number(bits) };
  });
}

// The refuse list follows the IANA special-purpose registries.
const BLOCKED_V4 = parseTable([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
]);
const BLOCKED_V6 = parseTable([
  "::/96",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  "2001::/32",
  "2001:db8::/32",
  "64:ff9b:1::/48",
]);
// Never allowable, whatever the operator lists: link-local plus the metadata hosts of Azure, Alibaba and the IETF
// protocol block's metadata address.
const NEVER_ALLOWABLE_V4 = parseTable([
  "169.254.0.0/16",
  "168.63.129.16/32",
  "100.100.100.200/32",
  "192.0.0.192/32",
]);
const LINK_LOCAL_V6 = parseTable(["fe80::/10"])[0] as Cidr;
const AWS_METADATA_V6 = parseTable(["fd00:ec2::254/128"])[0] as Cidr;

export function isBlockedAddress(address: string): boolean {
  const bytes = toBytes(address);
  if (bytes === undefined) return true;
  if (bytes.length === 4) return BLOCKED_V4.some((range) => inPrefix(bytes, range));
  if (BLOCKED_V6.some((range) => inPrefix(bytes, range))) return true;
  const inner = embeddedV4(bytes);
  return inner !== undefined && BLOCKED_V4.some((range) => inPrefix(inner, range));
}

export function isMetadataOrLinkLocal(address: string): boolean {
  const bytes = toBytes(address);
  if (bytes === undefined) return false;
  const v4 = bytes.length === 4 ? bytes : embeddedV4(bytes);
  if (v4 !== undefined) return NEVER_ALLOWABLE_V4.some((range) => inPrefix(v4, range));
  return inPrefix(bytes, LINK_LOCAL_V6) || inPrefix(bytes, AWS_METADATA_V6);
}

export function parseCidr(text: string): Cidr {
  const [address = "", length, ...rest] = text.split("/");
  const bytes = toBytes(address);
  if (rest.length > 0 || bytes === undefined || !/^\d{1,3}$/.test(length ?? ""))
    throw new RangeError("invalid CIDR");
  const bits = Number(length);
  if (bits > bytes.length * 8) throw new RangeError("invalid CIDR");
  return { bytes, bits };
}

export function cidrContains(range: Cidr, address: string): boolean {
  const bytes = toBytes(address);
  if (bytes === undefined) return false;
  const effective = range.bytes.length === 4 && bytes.length === 16 ? embeddedV4(bytes) : bytes;
  return effective !== undefined && inPrefix(effective, range);
}
