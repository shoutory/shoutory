import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import type { AccountAccess } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { CredentialError, openAccessToken } from "../../channels/credentials.js";
import { inJob, type Operation } from "./held.js";

export async function instanceHostOf(pool: AppPool, operation: Operation): Promise<string | null> {
  const { rows } = await inJob(pool, operation.workspace_id, (tx) =>
    tx.query("SELECT instance_host FROM app.channels WHERE workspace_id = $1 AND id = $2", [
      operation.workspace_id,
      operation.channel_id,
    ]),
  );
  return z.object({ instance_host: z.string().nullable() }).optional().parse(rows[0])?.instance_host ?? null;
}

export async function accountOf(
  options: { readonly pool: AppPool; readonly keys: KeyProvider },
  operation: Operation,
  instanceHost: string | null,
): Promise<AccountAccess | null> {
  try {
    const accessToken = await openAccessToken(
      options.pool,
      options.keys,
      operation.workspace_id,
      operation.channel_id,
    );
    return { accessToken, ...(instanceHost === null ? {} : { instanceHost }) };
  } catch (error) {
    if (error instanceof CredentialError) return null;
    throw error;
  }
}
