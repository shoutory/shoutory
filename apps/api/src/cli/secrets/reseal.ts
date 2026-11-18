import { EnvelopeError, open, type StoredSecret, seal } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { emailLinkAad } from "../../mail/enqueue.js";
import type { CliIo } from "../main.js";
import { openCustody } from "./check.js";

const BATCH_SIZE = 100;

interface OutboxRow {
  id: string;
  workspace_id: string | null;
  link_ciphertext: Buffer;
  link_iv: Buffer;
  link_auth_tag: Buffer;
  link_wrap_iv: Buffer;
  link_wrap_tag: Buffer;
  link_wrapped_dek: Buffer;
  link_key_id: string;
  link_format_version: number;
  link_generation: number;
}

const storedOf = (row: OutboxRow): StoredSecret => ({
  formatVersion: row.link_format_version,
  keyId: row.link_key_id,
  iv: row.link_iv,
  ciphertext: row.link_ciphertext,
  tag: row.link_auth_tag,
  wrapIv: row.link_wrap_iv,
  wrapTag: row.link_wrap_tag,
  wrappedDek: row.link_wrapped_dek,
});

/** Opens a row under its own key and generation and seals it again under the active key at generation + 1. */
async function resealRow(pool: AppPool, keys: KeyProvider, row: OutboxRow): Promise<boolean> {
  const link = open(
    storedOf(row),
    emailLinkAad(row.id, row.workspace_id, row.link_generation),
    keys,
  ).expose();
  const next = seal(link, emailLinkAad(row.id, row.workspace_id, row.link_generation + 1), keys);
  // False means another writer moved the row first (a concurrent reseal, or the send): nothing is left to do.
  const written = await pool.query(
    "SELECT app.email_outbox_reseal_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS written",
    [
      row.id,
      row.link_generation,
      next.ciphertext,
      next.iv,
      next.tag,
      next.wrapIv,
      next.wrapTag,
      next.wrappedDek,
      next.keyId,
      next.formatVersion,
    ],
  );
  return written.rows[0].written === true;
}

interface Tally {
  resealed: number;
  /** Rows whose write was refused because another writer changed them first. */
  moved: number;
  /** Key ids of the rows that could not be opened, with how many each. */
  skipped: Map<string, number>;
}

async function resealBatch(pool: AppPool, keys: KeyProvider, rows: OutboxRow[], tally: Tally): Promise<void> {
  for (const row of rows) {
    try {
      if (await resealRow(pool, keys, row)) tally.resealed += 1;
      else tally.moved += 1;
    } catch (error) {
      // Only a row that cannot be opened is skipped; any other failure ends the command.
      if (!(error instanceof EnvelopeError)) throw error;
      tally.skipped.set(row.link_key_id, (tally.skipped.get(row.link_key_id) ?? 0) + 1);
    }
  }
}

/**
 * `shoutory secrets reseal`: seals every row that holds a link under another key than the active one again under the
 * active key, in batches by id. A row that cannot be opened is skipped and counted by key id; the exit code is 1
 * when any was skipped. Rows already under the active key and sent rows are never touched, so a rerun is safe.
 */
export async function resealCommand(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { pool, keys } = openCustody(env, io);
  const tally: Tally = { resealed: 0, moved: 0, skipped: new Map() };
  try {
    let after: string | null = null;
    for (;;) {
      const found = await pool.query("SELECT * FROM app.email_outbox_reseal_batch($1, $2, $3)", [
        BATCH_SIZE,
        keys.activeKeyId(),
        after,
      ]);
      const rows = found.rows as OutboxRow[];
      const last = rows.at(-1);
      if (!last) break;
      await resealBatch(pool, keys, rows, tally);
      after = last.id;
    }
  } finally {
    await pool.end();
  }
  io.stdout(`resealed ${tally.resealed} under ${keys.activeKeyId()}`);
  if (tally.moved > 0) io.stdout(`moved by another writer: ${tally.moved}`);
  for (const [keyId, count] of tally.skipped)
    io.stderr(`skipped ${count} sealed under ${keyId}: cannot be opened`);
  return tally.skipped.size > 0 ? 1 : 0;
}
