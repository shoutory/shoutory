import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { ChannelProvider, CredentialService } from "../../channels/credentials.js";
import type { Logger } from "../../logging/logger.js";

export interface RevokingDeps {
  readonly pool: AppPool;
  readonly credentials: CredentialService;
  readonly providers: Readonly<Record<string, ChannelProvider>>;
  readonly logger: Logger;
}

// A disconnect that stopped between its two transactions leaves a credential `revoking`. After ten minutes the provider
// is asked once more and the secret bytes are overwritten whatever it answers.
export async function finishRevoking({
  pool,
  credentials,
  providers,
  logger,
}: RevokingDeps): Promise<number> {
  const stale = await withSystem(pool, "ledger", (tx) =>
    tx.query<{ workspace_id: string; channel_id: string; provider_id: string }>(
      "SELECT * FROM app.credentials_revoking_stale(interval '10 minutes')",
    ),
  );
  for (const row of stale.rows) {
    const provider = Object.hasOwn(providers, row.provider_id) ? providers[row.provider_id] : undefined;
    const outcome = provider
      ? await credentials.revoke(row.workspace_id, row.channel_id, provider)
      : "unsupported";
    await withSystem(pool, "ledger", (tx) =>
      tx.query("SELECT app.credential_destroy($1, $2)", [row.workspace_id, row.channel_id]),
    );
    logger.info(
      { event: "credential_revoking_finished", channel: row.channel_id, revoke: outcome },
      "finished a disconnect",
    );
  }
  return stale.rows.length;
}
