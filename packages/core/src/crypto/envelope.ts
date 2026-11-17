import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { KeyProvider } from "./keys.js";

export const CREDENTIAL_KINDS = ["email_link"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** The all-zero UUID: the scope of an instance-wide secret. */
export const NIL_SCOPE = "00000000-0000-0000-0000-000000000000";

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const REDACTED = "[redacted]";
// What Node raises when a GCM tag does not verify (the error has no code to match on).
const AUTH_FAILURE = "Unsupported state or unable to authenticate data";

export interface Aad {
  formatVersion: number;
  scopeId: string;
  ownerId: string;
  credentialKind: CredentialKind;
  generation: number;
}

/** The stored fields, kept separate (no packed string). */
export interface StoredSecret {
  formatVersion: number;
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  wrapIv: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
}

/** A refused seal or open; the message never carries key material or the value. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** A decrypted value. Nothing prints it: only `expose()` returns it, for the one call site that needs it. */
export class SealedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

// A JSON array is unambiguous whatever characters an id holds, unlike a delimiter-joined string.
const payloadAad = (aad: Aad): Buffer =>
  Buffer.from(
    JSON.stringify([aad.formatVersion, aad.scopeId, aad.ownerId, aad.credentialKind, aad.generation]),
  );
const wrapAad = (formatVersion: number, keyId: string): Buffer =>
  Buffer.from(JSON.stringify([formatVersion, keyId]));

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; data: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, data, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, iv: Buffer, data: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (error) {
    // Only the GCM authentication failure means "wrong key, context or bytes"; anything else surfaces as it is.
    if (error instanceof Error && error.message === AUTH_FAILURE) {
      throw new EnvelopeError("the secret cannot be opened with this key and context");
    }
    throw error;
  }
}

/** Seals under the active KEK: a random DEK encrypts the value and the KEK wraps the DEK. */
export function seal(plaintext: string, aad: Aad, keys: KeyProvider): StoredSecret {
  if (aad.formatVersion !== FORMAT_VERSION) throw new EnvelopeError("unsupported format version");
  if (!CREDENTIAL_KINDS.includes(aad.credentialKind)) throw new EnvelopeError("unknown credential kind");
  if (!Number.isSafeInteger(aad.generation) || aad.generation < 0) {
    throw new EnvelopeError("the generation must be a safe non-negative integer");
  }
  if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) throw new EnvelopeError("the value is too large");
  const keyId = keys.activeKeyId();
  const dek = randomBytes(DEK_BYTES);
  const payload = encrypt(dek, Buffer.from(plaintext, "utf8"), payloadAad(aad));
  const wrap = encrypt(keys.getKey(keyId), dek, wrapAad(aad.formatVersion, keyId));
  return {
    formatVersion: aad.formatVersion,
    keyId,
    iv: payload.iv,
    ciphertext: payload.data,
    tag: payload.tag,
    wrapIv: wrap.iv,
    wrappedDek: wrap.data,
    wrapTag: wrap.tag,
  };
}

function checkShape(stored: StoredSecret, aad: Aad, keys: KeyProvider): void {
  const buffers = [
    stored.iv,
    stored.ciphertext,
    stored.tag,
    stored.wrapIv,
    stored.wrappedDek,
    stored.wrapTag,
  ];
  if (!buffers.every(Buffer.isBuffer) || typeof stored.keyId !== "string") {
    throw new EnvelopeError("malformed secret");
  }
  const lengths = [stored.iv, stored.wrapIv].every((b) => b.length === IV_BYTES);
  const tags = [stored.tag, stored.wrapTag].every((b) => b.length === TAG_BYTES);
  if (stored.formatVersion !== FORMAT_VERSION || aad.formatVersion !== FORMAT_VERSION) {
    throw new EnvelopeError("unsupported format version");
  }
  if (!lengths || !tags || stored.wrappedDek.length !== DEK_BYTES)
    throw new EnvelopeError("malformed secret");
  if (!keys.has(stored.keyId)) throw new EnvelopeError("no key is loaded for the secret's key id");
}

/** Opens a stored secret; any wrong byte, key, key id, format version or AAD field raises `EnvelopeError`. */
export function open(stored: StoredSecret, aad: Aad, keys: KeyProvider): SealedSecret {
  checkShape(stored, aad, keys);
  const wrapKey = keys.getKey(stored.keyId);
  const wrapped = wrapAad(stored.formatVersion, stored.keyId);
  const dek = decrypt(wrapKey, stored.wrapIv, stored.wrappedDek, stored.wrapTag, wrapped);
  const plain = decrypt(dek, stored.iv, stored.ciphertext, stored.tag, payloadAad(aad));
  return new SealedSecret(plain.toString("utf8"));
}
