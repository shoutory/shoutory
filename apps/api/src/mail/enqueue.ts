import { type Aad, FORMAT_VERSION, NIL_SCOPE, type SealedSecret, seal } from "@shoutory/core/crypto";
import { pepperDigest } from "@shoutory/core/crypto/digest";
import type { KeyProvider } from "@shoutory/core/keys";
import { z } from "zod";
import { TEMPLATE_NAMES, TEMPLATES } from "./templates.js";

const MAX_LINK_LENGTH = 2048;
const MAX_RECIPIENT_LENGTH = 320;
const MAX_LOCALE_LENGTH = 16;

// Ids that enter the AAD are lower-cased, so the AAD always matches the spelling the database stores.
const lowerUuid = z.uuid().transform((value) => value.toLowerCase());

const mailSchema = z.strictObject({
  id: lowerUuid.optional(),
  workspaceId: lowerUuid.nullable(),
  recipient: z.email().max(MAX_RECIPIENT_LENGTH),
  template: z.enum(TEMPLATE_NAMES),
  locale: z.string().min(1).max(MAX_LOCALE_LENGTH),
  vars: z.record(z.string(), z.unknown()),
  link: z.string().min(1).max(MAX_LINK_LENGTH),
});

export type MailInput = z.input<typeof mailSchema>;

export interface MailDeps {
  readonly keys: KeyProvider;
  readonly pepper: SealedSecret;
}

export const emailLinkAad = (id: string, workspaceId: string | null, generation: number): Aad => ({
  formatVersion: FORMAT_VERSION,
  scopeId: workspaceId ?? NIL_SCOPE,
  ownerId: id,
  credentialKind: "email_link",
  generation,
});

// The purpose separates this digest from the other uses of the pepper.
const digestOf = (link: string, pepper: SealedSecret): string => pepperDigest(pepper, "email_link", link);

export interface MailDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export async function enqueueMail(db: MailDb, input: MailInput, deps: MailDeps): Promise<string> {
  const mail = mailSchema.parse(input);
  const vars = TEMPLATES[mail.template].vars.parse(mail.vars);
  const id = mail.id ?? String((await db.query("SELECT uuidv7() AS id")).rows[0]?.id);
  const sealed = seal(mail.link, emailLinkAad(id, mail.workspaceId, 0), deps.keys);
  await db.query(
    `SELECT app.email_outbox_enqueue($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      mail.workspaceId,
      mail.recipient,
      mail.template,
      mail.locale,
      JSON.stringify(vars),
      sealed.ciphertext,
      sealed.iv,
      sealed.tag,
      sealed.wrapIv,
      sealed.wrapTag,
      sealed.wrappedDek,
      sealed.keyId,
      sealed.formatVersion,
      digestOf(mail.link, deps.pepper),
    ],
  );
  return id;
}
