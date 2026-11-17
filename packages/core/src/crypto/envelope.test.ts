import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type Aad,
  CREDENTIAL_KINDS,
  type CredentialKind,
  EnvelopeError,
  NIL_SCOPE,
  open,
  type SealedSecret,
  type StoredSecret,
  seal,
} from "./envelope.js";
import { EnvKeyProvider } from "./keys.js";

const CANARY = "canary-secret-value-1";
const kek = (fill: number) => Buffer.alloc(32, fill);
const ringEnv = (active: string, ids: Record<string, number>) => ({
  SHOUTORY_ACTIVE_KEY_ID: active,
  ...Object.fromEntries(
    Object.entries(ids).map(([id, f]) => [
      `SHOUTORY_KEK_${id.toUpperCase().replace(/-/g, "_")}`,
      kek(f).toString("base64"),
    ]),
  ),
});
const ring = new EnvKeyProvider(ringEnv("k1", { k1: 1 }));
const aad: Aad = {
  formatVersion: 1,
  scopeId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  credentialKind: "email_link",
  generation: 1,
};
const flip = (b: Buffer) => Buffer.from(b.map((v, i) => (i === 0 ? v ^ 1 : v)));
const opens = (run: () => SealedSecret) => expect(run).toThrow(EnvelopeError);

describe("envelope round trip", () => {
  it.each(CREDENTIAL_KINDS)("seals and opens kind %s", (credentialKind) => {
    const a = { ...aad, credentialKind };
    expect(open(seal(CANARY, a, ring), a, ring).expose()).toBe(CANARY);
  });
  it("uses the nil scope for an instance secret", () => {
    const a = { ...aad, scopeId: NIL_SCOPE };
    expect(open(seal(CANARY, a, ring), a, ring).expose()).toBe(CANARY);
  });
});

describe("seal refuses input outside its bounds", () => {
  it.each([
    ["a NaN generation", { ...aad, generation: Number.NaN }],
    ["an infinite generation", { ...aad, generation: Number.POSITIVE_INFINITY }],
    ["a negative generation", { ...aad, generation: -1 }],
    ["a fractional generation", { ...aad, generation: 1.5 }],
    ["an unsafe-integer generation", { ...aad, generation: Number.MAX_SAFE_INTEGER + 1 }],
  ])("%s", (_name, bad) => {
    expect(() => seal(CANARY, bad, ring)).toThrow(EnvelopeError);
  });
  it("refuses a plaintext over 64 KiB and seals one of exactly 64 KiB", () => {
    expect(() => seal("x".repeat(65_537), aad, ring)).toThrow(EnvelopeError);
    const text = "x".repeat(65_536);
    expect(open(seal(text, aad, ring), aad, ring).expose()).toBe(text);
  });
});

describe("open surfaces a failure that is not an authentication failure", () => {
  it("lets an unexpected provider error through instead of calling it a bad secret", () => {
    const failing = {
      activeKeyId: () => "k1",
      has: () => true,
      getKey: (): Buffer => {
        throw new RangeError("key store unavailable");
      },
    };
    expect(() => open(seal(CANARY, aad, ring), aad, failing)).toThrow(RangeError);
  });
});

describe("envelope open refuses tampering", () => {
  const other = new EnvKeyProvider(ringEnv("k1", { k1: 9 }));
  const renamed = new EnvKeyProvider(ringEnv("k2", { k2: 1 }));
  type Mutate = (s: StoredSecret) => StoredSecret;
  const same: Mutate = (s) => s;
  it.each<[string, Mutate, EnvKeyProvider]>([
    ["a flipped ciphertext byte", (s) => ({ ...s, ciphertext: flip(s.ciphertext) }), ring],
    ["a flipped tag byte", (s) => ({ ...s, tag: flip(s.tag) }), ring],
    ["a flipped wrapped-DEK byte", (s) => ({ ...s, wrappedDek: flip(s.wrappedDek) }), ring],
    ["a flipped wrap tag byte", (s) => ({ ...s, wrapTag: flip(s.wrapTag) }), ring],
    ["a flipped wrap IV byte", (s) => ({ ...s, wrapIv: flip(s.wrapIv) }), ring],
    ["a flipped payload IV byte", (s) => ({ ...s, iv: flip(s.iv) }), ring],
    ["a different KEK under the same key id", same, other],
    ["a different key id", (s) => ({ ...s, keyId: "k2" }), renamed],
    ["a missing key id", (s) => ({ ...s, keyId: "k3" }), ring],
    ["a wrong format_version", (s) => ({ ...s, formatVersion: 2 }), ring],
    ["a ciphertext that is not a buffer", (s) => ({ ...s, ciphertext: "text" as unknown as Buffer }), ring],
    ["an IV that is not a buffer", (s) => ({ ...s, iv: "text" as unknown as Buffer }), ring],
    ["a wrapped DEK that is not a buffer", (s) => ({ ...s, wrappedDek: null as unknown as Buffer }), ring],
    ["a key id that is not a string", (s) => ({ ...s, keyId: 7 as unknown as string }), ring],
  ])("%s", (_name, mutate, keys) => opens(() => open(mutate(seal(CANARY, aad, ring)), aad, keys)));

  it("draws a fresh IV for every seal and every DEK wrap, never reusing one across the two", () => {
    const a = seal(CANARY, aad, ring);
    const b = seal(CANARY, aad, ring);
    const ivs = [a.iv, a.wrapIv, b.iv, b.wrapIv].map((v) => v.toString("hex"));
    expect(new Set(ivs).size).toBe(4);
    expect(a.iv.length).toBe(12);
    expect(a.tag.length).toBe(16);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe("envelope open fails when any AAD field differs", () => {
  // A kind outside the enum: open must fail at the payload AAD, not by pre-rejecting the kind.
  const otherKind = "channel_token" as CredentialKind;
  it.each([
    ["formatVersion", { ...aad, formatVersion: 2 }],
    ["scopeId", { ...aad, scopeId: NIL_SCOPE }],
    ["ownerId", { ...aad, ownerId: NIL_SCOPE }],
    ["credentialKind", { ...aad, credentialKind: otherKind }],
    ["generation", { ...aad, generation: 2 }],
  ])("a different %s", (_name, wrong) => opens(() => open(seal(CANARY, aad, ring), wrong, ring)));
});

describe("key rotation", () => {
  const old = new EnvKeyProvider(ringEnv("old-1", { "old-1": 3 }));
  const rotated = new EnvKeyProvider(ringEnv("new-1", { "new-1": 4, "old-1": 3 }));
  it("opens a row sealed under the retired KEK, and seals under the active one", () => {
    const stored = seal(CANARY, aad, old);
    expect(open(stored, aad, rotated).expose()).toBe(CANARY);
    expect(seal(CANARY, aad, rotated).keyId).toBe("new-1");
  });
  it("refuses a row whose key id is not in the ring", () => {
    opens(() => open(seal(CANARY, aad, old), aad, new EnvKeyProvider(ringEnv("new-1", { "new-1": 4 }))));
  });
});

describe("SealedSecret never prints its value", () => {
  const sealedValue = () => open(seal(CANARY, aad, ring), aad, ring);
  const surfaces: [string, (s: SealedSecret) => string][] = [
    ["JSON.stringify", (s) => JSON.stringify(s)],
    ["JSON.stringify nested", (s) => JSON.stringify({ token: s, list: [s] })],
    ["String", (s) => String(s)],
    ["template literal", (s) => `${s}`],
    ["util.inspect", (s) => inspect(s, { depth: 6, showHidden: true })],
    ["object spread", (s) => JSON.stringify({ ...s, kept: String(s) })],
    ["Object.assign", (s) => JSON.stringify(Object.assign({ kept: String(s) }, s))],
  ];
  it.each(surfaces)("through %s", (_name, show) => {
    const text = show(sealedValue());
    expect(text).not.toContain(CANARY);
    expect(text).toContain("[redacted]");
  });
  it("has no enumerable own property", () => {
    const sealed = sealedValue();
    expect(Object.keys(sealed)).toEqual([]);
    expect(
      Object.getOwnPropertyNames(sealed).filter((n) => String(Reflect.get(sealed, n)) === CANARY),
    ).toEqual([]);
  });
  it("keeps the value, the KEK and the DEK out of an open error", () => {
    let message = "";
    try {
      open({ ...seal(CANARY, aad, ring), tag: Buffer.alloc(16) }, aad, ring);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeError);
      message = `${String(error)}\n${(error as Error).stack}\n${inspect(error, { depth: 6 })}`;
    }
    expect(message).not.toBe("");
    for (const form of [CANARY, kek(1).toString("base64"), kek(1).toString("hex")])
      expect(message).not.toContain(form);
  });
});
