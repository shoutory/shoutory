import { type Aad, FORMAT_VERSION, NIL_SCOPE, open, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { TenantTx } from "@shoutory/db/context";
import type { AppCredentials } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { sealedParams } from "./credentials.js";

// The client secret is sealed under the row's own id; it is an instance-wide secret, so the nil scope and no salt.

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
  generation: z.number().int(),
});

const GET_APP = "SELECT * FROM app.instance_app_get($1, $2, $3, $4)";
const PUT_APP =
  "SELECT app.instance_app_put($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) AS stored";

// A stored app starts at generation 1; each reseal under a new key moves it one on.
const aadOf = (ownerId: string, generation: number): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: NIL_SCOPE,
  ownerId,
  credentialKind: "provider_instance_app",
  generation,
});

export interface AppKey {
  readonly workspaceId: string;
  readonly providerId: string;
  readonly instanceHost: string;
  /** An app serves only the scopes it was registered with, so a wider scope set needs its own app. */
  readonly scopes: string;
}

export async function readApp(
  tx: TenantTx,
  keys: KeyProvider,
  at: AppKey,
): Promise<AppCredentials | undefined> {
  const found = await tx.query(GET_APP, [at.workspaceId, at.providerId, at.instanceHost, at.scopes]);
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
  return { clientId: row.client_id, clientSecret: open(stored, aadOf(row.id, row.generation), keys) };
}

// The first writer of an instance wins and a later one gets false (it rereads the winner); a replace changes nothing
// when the client id it names is no longer the stored one.
export async function writeApp(
  tx: TenantTx,
  keys: KeyProvider,
  at: AppKey,
  app: AppCredentials,
  replaces: string | null,
): Promise<boolean> {
  const id = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
  const sealed = seal(app.clientSecret.expose(), aadOf(id, 1), keys);
  const stored = await tx.query(PUT_APP, [
    id,
    at.workspaceId,
    at.providerId,
    at.instanceHost,
    at.scopes,
    app.clientId,
    ...sealedParams(sealed),
    replaces,
  ]);
  return z.object({ stored: z.boolean() }).parse(stored.rows[0]).stored;
}
