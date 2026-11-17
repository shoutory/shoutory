import { hkdfSync } from "node:crypto";
import type { CredentialKind } from "./envelope.js";

const KEY_ID = /^[a-z0-9-]{1,32}$/;
const KEK_PREFIX = "SHOUTORY_KEK_";
const KEK_SUFFIX = /^[A-Z0-9_]{1,32}$/;
const ACTIVE_VARIABLE = "SHOUTORY_ACTIVE_KEY_ID";
const KEK_BYTES = 32;

/** A refused key operation; `variable` names the setting at fault and the message never carries key material. */
export class KeyError extends Error {
  constructor(
    message: string,
    readonly variable?: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** The one source of key-encryption keys; the cloud's KMS provider is the second implementation. */
export interface KeyProvider {
  activeKeyId(): string;
  has(keyId: string): boolean;
  getKey(keyId: string): Buffer;
}

/** The variable that holds a key id: uppercase, dash to underscore (underscore is outside the id alphabet). */
export function kekVariable(keyId: string): string {
  return `${KEK_PREFIX}${keyId.toUpperCase().replaceAll("-", "_")}`;
}

function parseKek(value: string, variable: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== KEK_BYTES || key.toString("base64") !== value) {
    throw new KeyError(`${variable} must be base64 of exactly ${KEK_BYTES} bytes`, variable);
  }
  if (key.every((byte) => byte === 0)) throw new KeyError(`${variable} must not be all zero`, variable);
  return key;
}

/** Self-host key ring: every `SHOUTORY_KEK_<ID>` is a key, `SHOUTORY_ACTIVE_KEY_ID` names the one that seals. */
export class EnvKeyProvider implements KeyProvider {
  readonly #active: string;
  readonly #keys = new Map<string, Buffer>();

  constructor(env: Readonly<Record<string, string | undefined>>) {
    for (const [variable, value] of Object.entries(env)) {
      if (!variable.startsWith(KEK_PREFIX) || value === undefined) continue;
      if (!KEK_SUFFIX.test(variable.slice(KEK_PREFIX.length))) {
        throw new KeyError(`${variable} does not name a key id`, variable);
      }
      this.#keys.set(variable, parseKek(value, variable));
    }
    const active = env[ACTIVE_VARIABLE];
    if (!active || !KEY_ID.test(active)) {
      throw new KeyError(
        `${ACTIVE_VARIABLE} must be a key id of 1-32 characters from a-z, 0-9 and "-"`,
        ACTIVE_VARIABLE,
      );
    }
    this.#active = active;
    if (!this.has(active)) throw new KeyError(`no key is loaded for the active key id`, kekVariable(active));
  }

  activeKeyId(): string {
    return this.#active;
  }

  has(keyId: string): boolean {
    return KEY_ID.test(keyId) && this.#keys.has(kekVariable(keyId));
  }

  getKey(keyId: string): Buffer {
    const key = KEY_ID.test(keyId) ? this.#keys.get(kekVariable(keyId)) : undefined;
    if (!key) throw new KeyError(`no key is loaded for key id "${keyId.slice(0, 32)}"`);
    return Buffer.from(key);
  }
}

/** Start-up check: every key id some stored row references must have a loaded key. */
export function assertKeyIdsLoaded(inUse: readonly string[], keys: KeyProvider): void {
  for (const id of inUse) {
    if (!keys.has(id)) {
      const variable = KEY_ID.test(id) ? kekVariable(id) : undefined;
      throw new KeyError(`key id "${id.slice(0, 32)}" is in use but no key is loaded for it`, variable);
    }
  }
}

/** The per-salt subkey that wraps a DEK: HKDF-SHA256 over the KEK, so deleting a salt shreds what it wrapped. */
export function deriveKey(
  kek: Buffer,
  salt: Uint8Array,
  kind: CredentialKind,
  formatVersion: number,
): Buffer {
  const info = `shoutory/${kind}/v${formatVersion}`;
  return Buffer.from(hkdfSync("sha256", kek, salt, info, KEK_BYTES));
}
