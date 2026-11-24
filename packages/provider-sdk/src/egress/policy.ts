import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import {
  type Cidr,
  cidrContains,
  isBlockedAddress,
  isMetadataOrLinkLocal,
  parseCidr,
} from "@shoutory/core/net";
import { EgressError } from "./errors.js";

/**
 * The request part of the policy: a provider's manifest hosts, the one instance host a channel stored (a provider whose
 * accounts live on user-chosen servers), or a user-supplied URL.
 */
export type RequestPolicy =
  | { readonly kind: "provider"; readonly egressHosts: readonly string[] }
  | { readonly kind: "instance"; readonly host: string }
  | { readonly kind: "user_url" };

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
type Lookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * The operator network policy, built once at start-up from instance configuration and never from a
 * workspace row or a request: the fixed refuse list minus the operator allowlist, metadata and link-local always refused.
 */
export interface OperatorPolicy {
  readonly ports: readonly number[];
  readonly schemes: readonly string[];
  readonly lookup: Lookup;
  readonly resolveTxt: ResolveTxt;
  allows(address: string): boolean;
}

export interface OperatorPolicyOptions {
  readonly allowCidrs: readonly string[];
  /** Allowed ports; 443 only by default. */
  readonly ports?: readonly number[];
  /** Allowed URL schemes; `https:` only by default. */
  readonly schemes?: readonly string[];
  /** The resolver; the system resolver by default. */
  readonly lookup?: Lookup;
  /** The TXT resolver; a `Resolver` with a 3 s timeout and 2 tries by default. */
  readonly resolveTxt?: ResolveTxt;
}

type ResolveTxt = (name: string) => Promise<string[][]>;

const TXT_TIMEOUT_MS = 3_000;
const TXT_TRIES = 2;
const systemResolveTxt: ResolveTxt = (name) =>
  new Resolver({ timeout: TXT_TIMEOUT_MS, tries: TXT_TRIES }).resolveTxt(name);

const systemLookup: Lookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export function createOperatorPolicy(options: OperatorPolicyOptions): OperatorPolicy {
  const allowed: Cidr[] = options.allowCidrs.map(parseCidr);
  for (const entry of options.allowCidrs) {
    if (isMetadataOrLinkLocal(entry.split("/")[0] ?? ""))
      throw new RangeError("a metadata range cannot be allowed");
  }
  return {
    ports: options.ports ?? [443],
    schemes: options.schemes ?? ["https:"],
    lookup: options.lookup ?? systemLookup,
    resolveTxt: options.resolveTxt ?? systemResolveTxt,
    allows: (address) =>
      !isMetadataOrLinkLocal(address) &&
      (!isBlockedAddress(address) || allowed.some((range) => cidrContains(range, address))),
  };
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { "https:": 443, "http:": 80 };

/** Checks everything about a URL that needs no DNS answer; returns the parsed URL or throws an `EgressError`. */
export function checkUrl(input: string, request: RequestPolicy, operator: OperatorPolicy): URL {
  if (!URL.canParse(input)) throw new EgressError({ class: "invalid_url", host: "" });
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const fail = (cls: "blocked_url" | "blocked_address" | "host_not_allowed") =>
    new EgressError({ class: cls, host });
  if (!operator.schemes.includes(url.protocol) || url.username || url.password) throw fail("blocked_url");
  if (!operator.ports.includes(Number(url.port || DEFAULT_PORTS[url.protocol]))) throw fail("blocked_url");
  if (request.kind === "provider" && !request.egressHosts.includes(host)) throw fail("host_not_allowed");
  if (request.kind === "instance" && request.host !== host) throw fail("host_not_allowed");
  if (isIP(host) > 0 && !operator.allows(host)) throw fail("blocked_address");
  return url;
}
