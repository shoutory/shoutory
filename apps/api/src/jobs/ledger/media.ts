import { createHash } from "node:crypto";
import type { StorageDriver } from "@shoutory/core/storage";
import type { AppPool } from "@shoutory/db/pool";
import { type MediaItem, MediaReadError, type MediaReader } from "@shoutory/provider-sdk/adapter";
import { type Held, inJob } from "./held.js";

interface Pin {
  readonly position: number;
  readonly mime: string | null;
  readonly derivative_state: string | null;
  readonly object_key: string | null;
  readonly byte_size: string | null;
  readonly derivative_sha256: Buffer;
  readonly has_derivative: boolean;
}

// Only the pins of the held operation are read, and only through the derivative the pin names.
async function pinsOf(pool: AppPool, held: Held): Promise<Pin[]> {
  const { operation } = held;
  const { rows } = await inJob(pool, operation.workspace_id, (tx) =>
    tx.query<Pin>(
      `SELECT m.position, a.mime, d.state AS derivative_state, d.object_key, d.byte_size::text AS byte_size,
              m.derivative_sha256, m.derivative_id IS NOT NULL AS has_derivative
         FROM app.operation_media m
         JOIN app.media_assets a ON a.workspace_id = m.workspace_id AND a.id = m.media_id
         LEFT JOIN app.media_derivatives d ON d.workspace_id = m.workspace_id AND d.id = m.derivative_id
        WHERE m.operation_id = $1
        ORDER BY m.position`,
      [operation.id],
    ),
  );
  return rows;
}

const refused = () => new MediaReadError("the medium cannot be served");

async function bytesOf(storage: StorageDriver, key: string, size: number): Promise<Buffer> {
  const head = await storage.head(key);
  if (head === null || head.size !== size) throw refused();
  const stream = await storage.get(key);
  if (stream === null) throw refused();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > size) throw refused();
    chunks.push(chunk);
  }
  if (total !== size) throw refused();
  return Buffer.concat(chunks);
}

// An original is never served, and an object whose size or hash differs from the pin is refused.
async function readPin(pin: Pin | undefined, storage: StorageDriver | undefined): Promise<Buffer> {
  const size = Number(pin?.byte_size);
  if (pin === undefined || storage === undefined || !pin.has_derivative) throw refused();
  if (pin.derivative_state !== "ready" || pin.object_key === null || !Number.isSafeInteger(size))
    throw refused();
  const bytes = await bytesOf(storage, pin.object_key, size);
  if (!createHash("sha256").update(bytes).digest().equals(pin.derivative_sha256)) throw refused();
  return bytes;
}

export async function mediaReader(
  pool: AppPool,
  held: Held,
  storage: StorageDriver | undefined,
  alts: readonly (string | null)[],
): Promise<MediaReader> {
  const pins = await pinsOf(pool, held);
  const items: MediaItem[] = pins.map((pin) => ({
    mime: pin.mime ?? "application/octet-stream",
    size: Number(pin.byte_size ?? 0),
    altText: alts[pin.position] ?? null,
  }));
  return {
    items,
    async read(position) {
      const bytes = await readPin(
        pins.find((pin) => pin.position === position),
        storage,
      );
      return { bytes, altText: alts[position] ?? null };
    },
  };
}
