import { createHash, randomUUID } from "node:crypto";
import type { StorageDriver } from "@shoutory/core/storage";
import { admin, rows } from "./ledger-dispatch-env.js";

export const sha = (text: string) => createHash("sha256").update(text).digest();

export interface Pin {
  /** What the object holds in storage. */
  stored: string;
  /** What the pin's hash was taken over; the stored object when absent. */
  pinned?: string;
  /** The size the derivative row records; the stored object's size when absent. */
  rowSize?: number;
  /** No derivative: the pin of an operation written before derivatives were pinned. */
  noDerivative?: true;
  alt?: string | null;
  mime?: string;
}

export const workspaceOf = async (id: string) =>
  String((await rows("SELECT workspace_id FROM app.operations WHERE id = $1", [id]))[0]?.workspace_id);

// Pins the media the way admission does: an object, its derivative, the pin and the frozen version's alt text.
export async function pinMedia(
  storage: StorageDriver,
  id: string,
  pins: Pin[],
): Promise<{ originals: string[] }> {
  const ws = await workspaceOf(id);
  const originals: string[] = [];
  const medium: { media_id: string; alt_text: string | null; crop: null }[] = [];
  for (const [position, pin] of pins.entries()) {
    const asset = randomUUID();
    const original = `ws/${ws}/${asset}/1/original`;
    const derivative = `ws/${ws}/${asset}/1/stripped`;
    originals.push(original);
    const stored = Buffer.from(pin.stored);
    await storage.put(original, new Blob([Buffer.from(`original-of-${pin.stored}`)]).stream(), 4096);
    await storage.put(derivative, new Blob([stored]).stream(), 4096);
    await admin(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO app.media_assets (id, workspace_id, object_key, file_name, mime, byte_size, state, sha256, source, created_by)
         VALUES ($1, $2, $3, 'pin.png', $7, $4, 'ready', $5, 'upload', $6)`,
        [asset, ws, original, stored.length, sha(asset), randomUUID(), pin.mime ?? "image/png"],
      );
      const derivativeId = randomUUID();
      await client.query(
        `INSERT INTO app.media_derivatives (id, workspace_id, media_id, profile, object_key, state, sha256, byte_size)
         VALUES ($1, $2, $3, 'stripped', $4, 'ready', $5, $6)`,
        [derivativeId, ws, asset, derivative, sha(pin.pinned ?? pin.stored), pin.rowSize ?? stored.length],
      );
      await client.query(
        `INSERT INTO app.operation_media (workspace_id, operation_id, position, media_id, derivative_id, derivative_sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ws, id, position, asset, pin.noDerivative ? null : derivativeId, sha(pin.pinned ?? pin.stored)],
      );
      await client.query("COMMIT");
    });
    medium.push({ media_id: asset, alt_text: pin.alt ?? null, crop: null });
  }
  await admin(async (client) => {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE app.post_versions SET snapshot = jsonb_set(snapshot, '{draft,variants,0,media}', $2::jsonb)
        WHERE id = (SELECT frozen_version_id FROM app.operations WHERE id = $1)`,
      [id, JSON.stringify(medium)],
    );
    await client.query("COMMIT");
  });
  return { originals };
}
