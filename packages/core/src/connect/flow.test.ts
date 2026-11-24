import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { flowObjectSchema, issuerAccepted, newState, pkcePair, providerErrorText } from "./flow.js";

describe("the state", () => {
  it("has at least 128 bits, differs per call and is stored as the digest of its bytes", () => {
    const first = newState();
    const bytes = Buffer.from(first.state, "base64url");
    expect(bytes.length).toBeGreaterThanOrEqual(16);
    expect(first.digest).toEqual(createHash("sha256").update(bytes).digest());
    expect(newState().state).not.toBe(first.state);
  });
});

describe("the PKCE pair", () => {
  it("is a verifier of 43 to 128 characters and its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });
});

describe("the sealed flow object", () => {
  it.each([
    ["a verifier", { code_verifier: "v".repeat(43) }, true],
    ["a verifier that is too short", { code_verifier: "v".repeat(42) }, false],
    ["a verifier that is too long", { code_verifier: "v".repeat(129) }, false],
    ["a field that is not the verifier", { code_verifier: "v".repeat(43), dpop_private_jwk: "{}" }, false],
    ["no verifier", {}, false],
  ])("%s", (_name, value, accepted) => {
    expect(flowObjectSchema.safeParse(value).success).toBe(accepted);
  });
});

describe("the iss of a callback (RFC 9207)", () => {
  it.each([
    ["the expected issuer", "https://issuer.example", "https://issuer.example", true],
    ["no iss when one is expected", "https://issuer.example", undefined, false],
    ["another iss", "https://issuer.example", "https://evil.example", false],
    ["the same issuer with a trailing slash", "https://issuer.example", "https://issuer.example/", false],
    ["an iss when none is expected", undefined, "https://anything.example", true],
    ["no iss when none is expected", undefined, undefined, true],
  ])("%s", (_name, expected, received, accepted) => {
    expect(issuerAccepted(expected, received)).toBe(accepted);
  });
});

describe("a provider's error text", () => {
  it.each([
    ["control characters are removed", "denied\u0000\u0007 by the user\u001b[31m", "denied by the user[31m"],
    ["markup stays literal text", "<b>no</b> & <script>x()</script>", "<b>no</b> & <script>x()</script>"],
    ["an absent text is empty", undefined, ""],
  ])("%s", (_name, raw, text) => {
    expect(providerErrorText(raw)).toBe(text);
  });

  it("is cut to 200 characters", () => {
    expect(providerErrorText("x".repeat(500))).toHaveLength(200);
  });
});
