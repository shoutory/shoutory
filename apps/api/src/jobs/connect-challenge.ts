import { type Aad, FORMAT_VERSION, open, SealedSecret } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import type { ChallengePoll } from "@shoutory/provider-sdk/result";
import { z } from "zod";
import type { HealthProvider } from "../channels/health.js";
import { wordDigest } from "../channels/secret-connect.js";
import type { Logger } from "../logging/logger.js";

export interface ChallengePollDeps {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly providers: Readonly<Record<string, HealthProvider>>;
  readonly fetchFor: (manifest: Manifest, instanceHost: string | undefined) => typeof fetch;
  readonly now: () => Date;
  readonly logger: Logger;
}

const PER_PASS = 50;
const bytes = z.instanceof(Buffer);
const dueSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  provider_id: z.string(),
  bot_digest: bytes,
  update_offset: z.coerce.number().int(),
  format_version: z.number().int(),
  key_id: z.string(),
  iv: bytes,
  ciphertext: bytes,
  auth_tag: bytes,
  wrap_iv: bytes,
  wrap_tag: bytes,
  wrapped_dek: bytes,
  salt: bytes.nullable(),
});
type Due = z.infer<typeof dueSchema>;

const aadOf = (row: Due): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: row.workspace_id,
  ownerId: row.id,
  credentialKind: "bot_token",
  generation: 1,
});

// `/connect word` in a private chat or channel, `/connect@bot word` in a group.
const CONNECT_WORD = /^\/connect(?:@\w+)?\s+(\S+)/;

const MATCH = "SELECT app.connect_challenge_match($1, $2, $3, $4, $5)";

// Reads the updates of every bot that has an unspent challenge, once each, and records the chat that sent a word. The
// offset moves in the same call, so an update is read once however many passes run.
//
// A bot that cannot be read (its token cannot be opened, or its provider fails) never stops the others. A database
// error is not that bot's: the other bots are finished, then the job fails with it.
export async function runChallengePoll(deps: ChallengePollDeps): Promise<number> {
  const due = await withSystem(deps.pool, "connect_challenge_poll", (tx) =>
    tx.query("SELECT * FROM app.connect_challenge_open_due($1)", [PER_PASS]),
  );
  // A row of a shape the definer does not give is a defect, not a bot's failure: it fails the job before any read.
  const rows = due.rows.map((raw) => dueSchema.parse(raw));
  let read = 0;
  let databaseError: unknown;
  for (const row of rows) {
    const provider = Object.hasOwn(deps.providers, row.provider_id)
      ? deps.providers[row.provider_id]
      : undefined;
    const poll = provider?.adapter.connect?.pollChallenge;
    if (!provider || !poll || row.salt === null) continue;
    const updates = await readUpdates(deps, provider, poll, { ...row, salt: row.salt });
    if (updates === undefined) continue;
    try {
      await recordUpdates(deps, row.bot_digest, updates);
      read += updates.messages.length;
    } catch (error) {
      databaseError ??= error;
    }
  }
  if (databaseError !== undefined) throw databaseError;
  return read;
}

const errorClassOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const warnUnreadable = (deps: ChallengePollDeps, providerId: string, errorClass: string | undefined) =>
  deps.logger.warn(
    { event: "connect_challenge_poll_failed", providerId, errorClass },
    "the updates of a bot could not be read",
  );

// Opens the bot's token and asks its provider for the updates after the offset; nothing here touches the database.
async function readUpdates(
  deps: ChallengePollDeps,
  provider: HealthProvider,
  poll: NonNullable<NonNullable<HealthProvider["adapter"]["connect"]>["pollChallenge"]>,
  row: Due & { salt: Buffer },
): Promise<ChallengePoll | undefined> {
  try {
    const result = await askProvider(deps, provider, poll, row);
    if (!result.ok || !result.poll) {
      warnUnreadable(deps, row.provider_id, result.errorClass);
      return undefined;
    }
    return result.poll;
  } catch (error) {
    warnUnreadable(deps, row.provider_id, errorClassOf(error));
    return undefined;
  }
}

async function askProvider(
  deps: ChallengePollDeps,
  provider: HealthProvider,
  poll: NonNullable<NonNullable<HealthProvider["adapter"]["connect"]>["pollChallenge"]>,
  row: Due & { salt: Buffer },
) {
  const token = open(
    {
      formatVersion: row.format_version,
      keyId: row.key_id,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.auth_tag,
      wrapIv: row.wrap_iv,
      wrapTag: row.wrap_tag,
      wrappedDek: row.wrapped_dek,
    },
    aadOf(row),
    deps.keys,
    row.salt,
  );
  return poll.call(
    provider.adapter.connect,
    { fetch: deps.fetchFor(provider.manifest, undefined), now: deps.now },
    { botToken: new SealedSecret(token.expose()), offset: row.update_offset },
  );
}

async function recordUpdates(
  deps: ChallengePollDeps,
  botDigest: Buffer,
  updates: ChallengePoll,
): Promise<void> {
  const { nextOffset, messages } = updates;
  await withSystem(deps.pool, "connect_challenge_poll", async (tx) => {
    for (const message of messages) {
      const word = CONNECT_WORD.exec(message.text)?.[1];
      if (word === undefined) continue;
      await tx.query(MATCH, [botDigest, wordDigest(word), message.chatId, message.title, nextOffset]);
    }
    await tx.query(MATCH, [botDigest, null, "", "", nextOffset]);
  });
}
