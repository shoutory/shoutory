export const MAX_KEY_BYTES = 1024;
export const MAX_KEY_SEGMENTS = 8;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

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

export function isStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_BYTES) return false;
  const segments = key.split("/");
  return (
    segments.length <= MAX_KEY_SEGMENTS &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  );
}

export function storageKeySegments(key: string): string[] {
  if (!isStorageKey(key)) throw new StorageError("invalid_key");
  return key.split("/");
}

export function checkRange(range: { start: number; end: number }): void {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
    throw new StorageError("invalid_key");
}

// A closed list, so a warning never carries text of the store.
export type StorageWarning =
  | "no_abort_rule"
  | "abort_rule_too_long"
  | "abort_rule_excludes_uploads"
  | "abort_rule_unreadable";

export interface StorageCheckInfo {
  readonly freeBytes: number | null;
  readonly warnings?: readonly StorageWarning[];
}

export interface StorageDriver {
  readonly name: "fs" | "s3";
  // Leaves nothing when the body passes `maxBytes`. With `ifAbsent` an existing object is kept and the write fails with
  // kind `exists`.
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
    options?: { ifAbsent?: boolean },
  ): Promise<void>;
  get(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<{ size: number; sha256?: string } | null>;
  delete(key: string): Promise<void>;
  check(): Promise<StorageCheckInfo>;
  close?(): void;
}
