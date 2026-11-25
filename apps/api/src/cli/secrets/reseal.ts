import {
  type Aad,
  CREDENTIAL_KINDS,
  type CredentialKind,
  EnvelopeError,
  FORMAT_VERSION,
  NIL_SCOPE,
  open,
  type StoredSecret,
  seal,
} from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import type { AppPool } from "@shoutory/db/pool";
import { emailLinkAad } from "../../mail/enqueue.js";
import type { CliIo } from "../main.js";
import { openCustody } from "./check.js";

const BATCH_SIZE = 100;

type Row = { readonly id: string } & Readonly<Record<string, unknown>>;

const storedOf = (row: Row, prefix: string): StoredSecret => ({
  formatVersion: row[`${prefix}format_version`] as number,
  keyId: row[`${prefix}key_id`] as string,
  iv: row[`${prefix}iv`] as Buffer,
  ciphertext: row[`${prefix}ciphertext`] as Buffer,
  tag: row[`${prefix}auth_tag`] as Buffer,
  wrapIv: row[`${prefix}wrap_iv`] as Buffer,
  wrapTag: row[`${prefix}wrap_tag`] as Buffer,
  wrappedDek: row[`${prefix}wrapped_dek`] as Buffer,
});

/** One sealed table the reseal moves: its batch and write definers and what its secret is bound to. */
interface SealedTable {
  readonly batch: string;
  readonly write: string;
  readonly prefix: string;
  readonly generationOf: (row: Row) => number;
  readonly aadOf: (row: Row, generation: number) => Aad;
  readonly saltOf?: (row: Row) => Buffer | undefined;
}

const credentialKindOf = (row: Row): CredentialKind => {
  const kind = row.kind as CredentialKind;
  // A kind the envelope does not know was never sealed by this release; it is counted as skipped.
  if (!CREDENTIAL_KINDS.includes(kind)) throw new EnvelopeError("unknown credential kind");
  return kind;
};

const TABLES: readonly SealedTable[] = [
  {
    batch: "email_outbox_reseal_batch",
    write: "email_outbox_reseal_write",
    prefix: "link_",
    generationOf: (row) => row.link_generation as number,
    aadOf: (row, generation) => emailLinkAad(row.id, row.workspace_id as string | null, generation),
  },
  {
    batch: "channel_credentials_reseal_batch",
    write: "channel_credentials_reseal_write",
    prefix: "",
    generationOf: (row) => row.generation as number,
    aadOf: (row, generation) => ({
      formatVersion: FORMAT_VERSION,
      scopeId: row.workspace_id as string,
      ownerId: row.channel_id as string,
      credentialKind: credentialKindOf(row),
      generation,
    }),
    saltOf: (row) => (row.salt as Buffer | null) ?? undefined,
  },
  {
    batch: "instance_apps_reseal_batch",
    write: "instance_apps_reseal_write",
    prefix: "secret_",
    generationOf: (row) => row.secret_generation as number,
    aadOf: (row, generation) => ({
      formatVersion: FORMAT_VERSION,
      scopeId: NIL_SCOPE,
      ownerId: row.id,
      credentialKind: "provider_instance_app",
      generation,
    }),
  },
];

type Outcome = "resealed" | "moved" | "busy";

async function resealRow(pool: AppPool, keys: KeyProvider, table: SealedTable, row: Row): Promise<Outcome> {
  const generation = table.generationOf(row);
  const salt = table.saltOf?.(row);
  const plain = open(storedOf(row, table.prefix), table.aadOf(row, generation), keys, salt).expose();
  const next = seal(plain, table.aadOf(row, generation + 1), keys, salt);
  // The email and instance app writes answer true or false; the credential write answers resealed or busy.
  const written = await pool.query(
    `SELECT app.${table.write}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)::text AS outcome`,
    [
      row.id,
      generation,
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
  const outcome = String(written.rows[0]?.outcome);
  if (outcome === "busy") return "busy";
  return outcome === "true" || outcome === "resealed" ? "resealed" : "moved";
}

interface Tally {
  counts: Record<Outcome, number>;
  skipped: Map<string, number>;
}

async function resealBatch(pool: AppPool, keys: KeyProvider, table: SealedTable, rows: Row[], tally: Tally) {
  for (const row of rows) {
    try {
      tally.counts[await resealRow(pool, keys, table, row)] += 1;
    } catch (error) {
      if (!(error instanceof EnvelopeError)) throw error;
      const keyId = row[`${table.prefix}key_id`] as string;
      tally.skipped.set(keyId, (tally.skipped.get(keyId) ?? 0) + 1);
    }
  }
}

async function resealTable(pool: AppPool, keys: KeyProvider, table: SealedTable, tally: Tally) {
  let after: string | null = null;
  for (;;) {
    const found = await pool.query(`SELECT * FROM app.${table.batch}($1, $2, $3)`, [
      BATCH_SIZE,
      keys.activeKeyId(),
      after,
    ]);
    const rows = found.rows as Row[];
    const last = rows.at(-1);
    if (!last) return;
    await resealBatch(pool, keys, table, rows, tally);
    after = last.id;
  }
}

/**
 * `shoutory secrets reseal`: seals every email link, channel credential and instance app secret held under another
 * key than the active one again under the active key, in batches by id. A row that cannot be opened is skipped and
 * counted by key id, and the exit code is 1 when any was skipped. A credential under a live refresh is counted busy
 * and left for a rerun. Rows already under the active key are never touched, so a rerun is safe; OAuth flows expire
 * within minutes and are never resealed.
 */
export async function resealCommand(env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { pool, keys } = openCustody(env, io);
  const tally: Tally = { counts: { resealed: 0, moved: 0, busy: 0 }, skipped: new Map() };
  try {
    for (const table of TABLES) await resealTable(pool, keys, table, tally);
  } finally {
    await pool.end();
  }
  io.stdout(`resealed ${tally.counts.resealed} under ${keys.activeKeyId()}`);
  if (tally.counts.moved > 0) io.stdout(`moved by another writer: ${tally.counts.moved}`);
  if (tally.counts.busy > 0) io.stdout(`busy: ${tally.counts.busy} under a refresh; run reseal again`);
  for (const [keyId, count] of tally.skipped)
    io.stderr(`skipped ${count} sealed under ${keyId}: cannot be opened`);
  return tally.skipped.size > 0 ? 1 : 0;
}
