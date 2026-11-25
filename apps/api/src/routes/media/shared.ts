import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import type { StorageDriver } from "@shoutory/core/storage";
import type { TenantTx } from "@shoutory/db/context";
import { z } from "zod";
import { Refusal } from "../../errors/refusal.js";
import { definerRefusal } from "../definer-refusal.js";

const uuid = z.uuid().transform((id) => id.toLowerCase());
export const workspaceParams = z.strictObject({ workspace_id: uuid });
export const mediaParams = z.strictObject({ workspace_id: uuid, media_id: uuid });

export const BASE = "/api/v1/workspaces/{workspace_id}/media";
const EDIT = { workspace: "workspace_id", permission: "library.edit" } as const;
export const EDIT_SPLIT = { ...EDIT, split: true } as const;
export const VIEW_SPLIT = { workspace: "workspace_id", permission: "library.view", split: true } as const;
export const LIVE = ["uploaded", "scanning", "processing", "ready"];

// The type of the file comes from its bytes, never from the sender, so every upload body is plain octet-stream.
export const OCTET_STREAM = /^application\/octet-stream\s*(;|$)/i;

// The key the register definer derives for version 1 of an original.
export const originalKey = (workspaceId: string, mediaId: string) =>
  `ws/${workspaceId}/${mediaId}/1/original`;

const ASSET = `SELECT id, state, mime, byte_size, encode(sha256, 'hex') AS sha256, created_at FROM app.media_assets
  WHERE workspace_id = $1 AND id = $2`;
export interface Asset {
  id: string;
  state: string;
  created_at: Date;
  mime: string | null;
  byte_size: string | null;
  sha256: string | null;
}

export async function assetOf(tx: TenantTx, workspaceId: string, id: string): Promise<Asset> {
  const row = (await tx.query<Asset>(ASSET, [workspaceId, id])).rows[0];
  if (!row) throw new Refusal("not_found", "media row not visible");
  return row;
}

export interface UploadSession {
  multipart_upload_id: string | null;
  part_size: number | null;
  declared_sha256: string | null;
  declared_size: number | null;
  open: boolean;
}

export async function uploadOf(
  tx: TenantTx,
  workspaceId: string,
  id: string,
): Promise<UploadSession | undefined> {
  return (
    await tx.query<UploadSession>(
      `SELECT multipart_upload_id, part_size, encode(declared_sha256, 'hex') AS declared_sha256,
         declared_size::float8 AS declared_size, expires_at > clock_timestamp() AS open
       FROM app.media_uploads WHERE workspace_id = $1 AND media_id = $2`,
      [workspaceId, id],
    )
  ).rows[0];
}

export async function callDefiner<T extends Record<string, unknown>>(
  tx: TenantTx,
  sql: string,
  params: unknown[],
): Promise<T> {
  try {
    return (await tx.query<T>(sql, params)).rows[0] as T;
  } catch (error) {
    throw definerRefusal(error) ?? error;
  }
}

export type Scope = <T>(
  write: boolean,
  run: (tx: TenantTx, scope: AuthorizedScope) => Promise<T>,
) => Promise<T>;

export const conflict = (reason: string) =>
  new Refusal("conflict", `upload not completed: ${reason}`, { details: { reason } });

// `duplicate` says the file was already in the workspace: the answer names that medium instead of the one asked.
export interface Settled {
  id: string;
  duplicate: boolean;
}
const settledAs = (asked: string, live: string): Settled => ({ id: live, duplicate: live !== asked });

export async function settled(
  storage: StorageDriver,
  workspaceId: string,
  asset: Asset,
  scoped: Scope,
): Promise<Settled> {
  if (LIVE.includes(asset.state)) return settledAs(asset.id, asset.id);
  const head = await storage.head(originalKey(workspaceId, asset.id));
  const live = head?.sha256
    ? (
        await scoped(false, (tx) =>
          tx.query<{ id: string }>(
            `SELECT id FROM app.media_assets WHERE workspace_id = $1 AND sha256 = decode($2, 'hex')
             AND state = ANY($3) ORDER BY created_at LIMIT 1`,
            [workspaceId, head.sha256, LIVE],
          ),
        )
      ).rows[0]
    : undefined;
  if (!live) throw conflict("not_pending");
  return settledAs(asset.id, live.id);
}

/**
 * Marks a pending upload uploaded with the digest and size it is given. When a complete that ran at the same time
 * finished it first, the definer refuses with a conflict and this answers what that one settled, once.
 */
export async function markUploaded(
  storage: StorageDriver,
  workspaceId: string,
  asset: Asset,
  scoped: Scope,
  proved: { sha256: string; size: number },
): Promise<Settled> {
  try {
    const done = await scoped(true, (tx, scope) =>
      callDefiner<{ outcome: string; live_id: string }>(
        tx,
        "SELECT * FROM app.media_mark_uploaded($1, $2, decode($3, 'hex'), $4, $5)",
        [scope.workspaceId, asset.id, proved.sha256, proved.size, asset.mime ?? "application/octet-stream"],
      ),
    );
    return settledAs(asset.id, done.live_id);
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== "conflict") throw error;
    const now = await scoped(false, (tx, scope) => assetOf(tx, scope.workspaceId, asset.id));
    if (now.state === "pending_upload") throw error;
    return settled(storage, workspaceId, now, scoped);
  }
}
