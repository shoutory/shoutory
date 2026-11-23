/** Where objects live. Keys are opaque ids built by the caller, never user text and never filesystem paths. */

export const MAX_KEY_BYTES = 1024;
export const MAX_KEY_SEGMENTS = 8;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Why a driver refused an operation; the message never carries a key or a path. */
export type StorageErrorKind =
  | "invalid_key"
  | "outside_root"
  | "too_large"
  | "exists"
  | "unsupported"
  | "denied"
  | "failed";

export class StorageError extends Error {
  constructor(readonly kind: StorageErrorKind) {
    super(`storage refused the operation: ${kind}`);
    this.name = "StorageError";
  }
}

/** `/`-joined segments of letters, digits, `.`, `_` and `-`; no empty, `.` or `..` segment; bounded in bytes and depth. */
export function isStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_BYTES) return false;
  const segments = key.split("/");
  return (
    segments.length <= MAX_KEY_SEGMENTS &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  );
}

/** The key's segments, or a refusal. Every driver resolves a key through this one function. */
export function storageKeySegments(key: string): string[] {
  if (!isStorageKey(key)) throw new StorageError("invalid_key");
  return key.split("/");
}

/** A byte range both drivers accept: whole numbers, `start` from 0, `end` not before `start` (both inclusive). */
export function checkRange(range: { start: number; end: number }): void {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
    throw new StorageError("invalid_key");
}

export interface StorageCheckInfo {
  /** Bytes a write can still use, or null where the driver cannot tell. */
  readonly freeBytes: number | null;
}

export interface StorageDriver {
  readonly name: "fs" | "s3";
  /**
   * Stores the body under `key`; refuses and leaves nothing when it passes `maxBytes`. It replaces any object there,
   * unless `ifAbsent` is set: then an existing object is kept and the write fails with kind `exists`.
   */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
    options?: { ifAbsent?: boolean },
  ): Promise<void>;
  /** The object's bytes, or null for a missing key; `range` keeps the bytes from `start` to `end`, both inclusive. */
  get(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
  /** The object's size in bytes and, where the store keeps one, its sha256 as lower-case hex; null for a missing key. */
  head(key: string): Promise<{ size: number; sha256?: string } | null>;
  /** Removes the object; a missing key is a no-op. */
  delete(key: string): Promise<void>;
  /** What the driver can report about itself without writing. */
  check(): Promise<StorageCheckInfo>;
  /** Releases the connections the driver holds; a driver that holds none has no `close`. */
  close?(): void;
}
