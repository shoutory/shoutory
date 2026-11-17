import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_KINDS } from "./envelope.js";
import { deriveKey, EnvKeyProvider, KeyError } from "./keys.js";

const kek = Buffer.alloc(32, 5);

describe("HKDF subkey", () => {
  const kind = CREDENTIAL_KINDS[0];
  const salt = Buffer.from("workspace-salt-1");

  it("is stable for one KEK and salt, differs per salt and from the KEK", () => {
    const first = deriveKey(kek, salt, kind, 1);
    expect(deriveKey(kek, salt, kind, 1).equals(first)).toBe(true);
    expect(deriveKey(kek, Buffer.from("workspace-salt-2"), kind, 1).equals(first)).toBe(false);
    expect(first.equals(kek)).toBe(false);
    expect(first.length).toBe(32);
  });

  it("differs per format version", () => {
    expect(deriveKey(kek, salt, kind, 2).equals(deriveKey(kek, salt, kind, 1))).toBe(false);
  });
});

describe("EnvKeyProvider", () => {
  const env = {
    SHOUTORY_ACTIVE_KEY_ID: "my-key",
    SHOUTORY_KEK_MY_KEY: kek.toString("base64"),
  };

  it("maps a key id to SHOUTORY_KEK_<ID> (uppercase, dash to underscore)", () => {
    const provider = new EnvKeyProvider(env);
    expect(provider.activeKeyId()).toBe("my-key");
    expect(provider.getKey("my-key").equals(kek)).toBe(true);
    expect(provider.has("other")).toBe(false);
    expect(() => provider.getKey("other")).toThrow(KeyError);
  });

  it("never prints a KEK in raw, base64 or hex form through any serializer", () => {
    const provider = new EnvKeyProvider(env);
    const shown = [JSON.stringify(provider), String(provider), inspect(provider, { depth: 6 })].join("\n");
    for (const form of [kek.toString("base64"), kek.toString("hex"), kek.toString("latin1")]) {
      expect(shown).not.toContain(form);
    }
  });
});
