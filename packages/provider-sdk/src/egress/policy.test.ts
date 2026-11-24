import { describe, expect, it } from "vitest";
import { EgressError } from "./errors.js";
import { checkUrl, createOperatorPolicy } from "./policy.js";

const userUrl = { kind: "user_url" } as const;
const strict = createOperatorPolicy({ allowCidrs: [] });

describe("the egress URL check", () => {
  it.each([
    ["decimal", "https://2130706433/"],
    ["hex", "https://0x7f000001/"],
    ["octal", "https://0177.0.0.1/"],
    ["short form", "https://127.1/"],
    ["userinfo before a literal", "https://example.com@127.0.0.1/"],
    ["userinfo with a password", "https://user:secret-1@example.com/"],
    ["bracketed mapped v6", "https://[::ffff:7f00:1]/"],
    ["metadata", "https://169.254.169.254/latest/meta-data/"],
    ["a scheme other than https", "http://example.com/"],
    ["file scheme", "file:///etc/hosts"],
    ["a port other than 443", "https://example.com:8443/"],
    ["port 80 under a default policy", "https://example.com:80/"],
  ])("an IP literal or URL form is refused: %s", (_name, url) => {
    expect(() => checkUrl(url, userUrl, strict)).toThrow(EgressError);
  });

  it("accepts a plain public https URL", () => {
    expect(checkUrl("https://example.com/path?q=1", userUrl, strict).hostname).toBe("example.com");
  });

  it("a host not in egressHosts is refused for a provider policy", () => {
    const provider = { kind: "provider", egressHosts: ["api.example.com"] } as const;
    expect(checkUrl("https://api.example.com/v1", provider, strict).hostname).toBe("api.example.com");
    expect(() => checkUrl("https://other.example.com/v1", provider, strict)).toThrow(EgressError);
  });
});

// Nothing the instance answers (a redirect, a discovery document) can widen the stored host.
describe("an instance request reaches only the channel's own stored host", () => {
  const own = { kind: "instance", host: "social.example" } as const;

  it("accepts its own host", () => {
    expect(checkUrl("https://social.example/api/v2/instance", own, strict).hostname).toBe("social.example");
  });

  it.each([
    ["another host", "https://other.example/api/v2/instance"],
    ["a sub-domain of its own host", "https://evil.social.example/"],
    ["its own host as a sub-domain of another", "https://social.example.evil.test/"],
  ])("refuses %s with host_not_allowed", (_name, url) => {
    expect(() => checkUrl(url, own, strict)).toThrow(expect.objectContaining({ class: "host_not_allowed" }));
  });
});

describe("the operator allowlist (one policy for every user URL)", () => {
  const selfHost = createOperatorPolicy({ allowCidrs: ["10.0.0.0/8", "127.0.0.1/32"] });

  it.each([
    ["10.1.1.1", true],
    ["127.0.0.1", true],
    ["192.168.1.1", false],
    ["8.8.8.8", true],
    ["169.254.169.254", false],
    ["fe80::1", false],
    ["::ffff:169.254.169.254", false],
  ])("allows(%s) is %s with the listed CIDRs", (address, expected) => {
    expect(selfHost.allows(address)).toBe(expected);
  });

  it("an empty allowlist refuses every private range", () => {
    expect(strict.allows("10.1.1.1")).toBe(false);
    expect(strict.allows("127.0.0.1")).toBe(false);
  });

  it("metadata and link-local never pass, even under a CIDR that covers them", () => {
    const wide = createOperatorPolicy({ allowCidrs: ["0.0.0.0/0", "::/0"] });
    expect(wide.allows("10.0.0.1")).toBe(true);
    expect(wide.allows("169.254.169.254")).toBe(false);
    expect(wide.allows("fe80::1")).toBe(false);
    expect(wide.allows("fd00:ec2::254")).toBe(false);
  });

  it.each(["169.254.0.0/16", "fe80::/10", "::ffff:169.254.169.254/128"])(
    "a metadata or link-local entry %s is refused when the policy is built",
    (cidr) => {
      expect(() => createOperatorPolicy({ allowCidrs: [cidr] })).toThrow();
    },
  );

  it.each(["168.63.129.16", "100.100.100.200", "192.0.0.192"])(
    "the metadata host %s is refused under a wide allowlist and cannot be listed",
    (address) => {
      const wide = createOperatorPolicy({ allowCidrs: ["0.0.0.0/0"] });
      expect(wide.allows(address)).toBe(false);
      expect(() => createOperatorPolicy({ allowCidrs: [`${address}/32`] })).toThrow();
    },
  );

  it("no request input widens the policy", () => {
    const hostile = { kind: "user_url", allowCidrs: ["10.0.0.0/8"], allowPrivate: true } as never;
    expect(() => checkUrl("https://10.0.0.1/", hostile, strict)).toThrow(EgressError);
  });
});
