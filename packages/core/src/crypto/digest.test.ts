import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pepperDigest } from "./digest.js";
import { SealedSecret } from "./envelope.js";

const PEPPER = new SealedSecret("digest-pepper-for-tests-0123456789abcdef");

describe("pepperDigest", () => {
  it("is the HMAC-SHA256 of purpose:value under the pepper, in lower-case hex", () => {
    const expected = createHmac("sha256", Buffer.from(PEPPER.expose()))
      .update("refresh:value-1")
      .digest("hex");
    expect(pepperDigest(PEPPER, "refresh", "value-1")).toBe(expected);
  });

  it("gives the same value a different digest under another purpose or pepper", () => {
    const other = new SealedSecret("another-pepper-for-tests-0123456789abcdef");
    const digests = [
      pepperDigest(PEPPER, "refresh", "value-1"),
      pepperDigest(PEPPER, "audit_ip", "value-1"),
      pepperDigest(other, "refresh", "value-1"),
    ];
    expect(new Set(digests).size).toBe(3);
  });
});
