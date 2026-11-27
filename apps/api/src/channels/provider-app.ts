import { type Aad, FORMAT_VERSION, NIL_SCOPE, open, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { TenantTx } from "@shoutory/db/context";
import type { AppCredentials } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { sealedParams } from "./credentials.js";

// The one app of a provider for the whole instance, sealed under the row's own id with the nil scope and no salt.

const bytes = z.instanceof(Buffer);
const rowSchema = z.object({
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

const ENSURE =
  "SELECT * FROM app.provider_app_ensure($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)";

const aadOf = (ownerId: string, generation: number): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: NIL_SCOPE,
  ownerId,
  credentialKind: "provider_instance_app",
  generation,
});

function appOf(keys: KeyProvider, found: Record<string, unknown> | undefined): AppCredentials | undefined {
  if (!found) return undefined;
  const row = rowSchema.parse(found);
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

// A person names the workspace they are an Admin of; a job names none.
export async function readProviderApp(
  tx: TenantTx,
  keys: KeyProvider,
  providerId: string,
  workspaceId: string | null,
): Promise<AppCredentials | undefined> {
  const found = await tx.query(ENSURE, [workspaceId, null, providerId, ...Array<null>(10).fill(null)]);
  return appOf(keys, found.rows[0]);
}

// The first writer wins: a later candidate is dropped and the stored app comes back, so every caller ends with one app.
export async function ensureProviderApp(
  tx: TenantTx,
  keys: KeyProvider,
  providerId: string,
  workspaceId: string | null,
  made: AppCredentials & { readonly redirectUri: string },
): Promise<AppCredentials> {
  const id = String((await tx.query("SELECT uuidv7() AS id")).rows[0]?.id);
  const sealed = seal(made.clientSecret.expose(), aadOf(id, 1), keys);
  const found = await tx.query(ENSURE, [
    workspaceId,
    id,
    providerId,
    made.clientId,
    made.redirectUri,
    ...sealedParams(sealed),
  ]);
  const stored = appOf(keys, found.rows[0]);
  if (!stored) throw new Error("the provider app was not stored");
  return stored;
}
