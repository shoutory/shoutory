import { type Aad, FORMAT_VERSION, NIL_SCOPE, open, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { TenantTx } from "@shoutory/db/context";
import type { AppCredentials } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { sealedParams } from "./credentials.js";

// The per-instance app of a provider whose accounts live on user-chosen servers: the client id in the clear, the client
// secret sealed under the row's own id (an instance-wide secret, so the nil scope and no salt). The table is reached only
// through two definers for a user who may manage the workspace's channels; nothing here makes an outbound call.

const bytes = z.instanceof(Buffer);
const appRowSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  format_version: z.number().int(),
  key_id: z.string(),
  iv: bytes,
  ciphertext: bytes,
  auth_tag: bytes,
  wrap_iv: bytes,
  wrap_tag: bytes,
  wrapped_dek: bytes,
});

const GET_APP = "SELECT * FROM app.instance_app_get($1, $2, $3)";
const PUT_APP =
  "SELECT app.instance_app_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS stored";

const aadOf = (ownerId: string): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: NIL_SCOPE,
  ownerId,
  credentialKind: "provider_instance_app",
  generation: 1,
});

/** Where an app is stored: the workspace of the caller (who must manage its channels), the provider and the instance. */
export interface AppKey {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly instanceHost: string;
}

/** The stored app of an instance, opened, or none. */
export async function readApp(
  tx: TenantTx,
  keys: KeyProvider,
  at: AppKey,
): Promise<AppCredentials | undefined> {
  const found = await tx.query(GET_APP, [at.workspaceId, at.providerId, at.instanceHost]);
  if (!found.rows[0]) return undefined;
  const row = appRowSchema.parse(found.rows[0]);
  const stored = {
    formatVersion: row.format_version,
    keyId: row.key_id,
    iv: row.iv,
    ciphertext: row.ciphertext,
    tag: row.auth_tag,
    wrapIv: row.wrap_iv,
    wrapTag: row.wrap_tag,
    wrappedDek: row.wrapped_dek,
  };
  return { clientId: row.client_id, clientSecret: open(stored, aadOf(row.id), keys) };
}

/**
 * Seals and stores an app; true when the stored row is this one. The first writer of an instance wins and a later one is
 * told false (it rereads the winner); a replace names the client id it replaces and changes nothing when that id is no
 * longer the stored one.
 */
export async function writeApp(
  tx: TenantTx,
  keys: KeyProvider,
  at: AppKey,
  app: AppCredentials,
  replaces: string | null,
): Promise<boolean> {
  const id = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
  const sealed = seal(app.clientSecret.expose(), aadOf(id), keys);
  const stored = await tx.query(PUT_APP, [
    id,
    at.workspaceId,
    at.providerId,
    at.instanceHost,
    app.clientId,
    ...sealedParams(sealed),
    replaces,
  ]);
  return z.object({ stored: z.boolean() }).parse(stored.rows[0]).stored;
}
