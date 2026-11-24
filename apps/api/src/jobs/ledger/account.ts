import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import type { AccountAccess } from "@shoutory/provider-sdk/adapter";
import { z } from "zod";
import { CredentialError, openAccessToken } from "../../channels/credentials.js";
import { inJob, type Operation } from "./held.js";

// What a worker hands the adapter of a claimed operation: the access token of the operation's own channel, opened with
// that workspace's salt, and the instance host the channel stored. A channel with no usable credential (none stored, or
// its salt was deleted) has none: the caller fails the operation before any call, with no effect.

/** The instance host a channel stored, as the worker role reads it; none for a provider with fixed hosts. */
export async function instanceHostOf(pool: AppPool, operation: Operation): Promise<string | null> {
  const { rows } = await inJob(pool, operation.workspace_id, (tx) =>
    tx.query("SELECT instance_host FROM app.channels WHERE workspace_id = $1 AND id = $2", [
      operation.workspace_id,
      operation.channel_id,
    ]),
  );
  return z.object({ instance_host: z.string().nullable() }).optional().parse(rows[0])?.instance_host ?? null;
}

/** The access of the operation's channel, or null when the channel has no usable credential. */
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
