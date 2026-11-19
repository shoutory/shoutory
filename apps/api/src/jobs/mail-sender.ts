import { type Aad, open, type SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import { createTransport, type Transporter } from "nodemailer";
import type { Logger } from "../logging/logger.js";
import { emailLinkAad } from "../mail/enqueue.js";
import { type MailTemplate, TEMPLATES } from "../mail/templates.js";
import { unsubscribeToken } from "../routes/unsubscribe.js";
import { intervalLoop } from "./outbox-relay.js";

export interface MailSenderOptions {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  /** Keys the unsubscribe token of a marketing mail. */
  readonly pepper: SealedSecret;
  readonly smtpUrl: SealedSecret;
  /** The transactional sender (`SHOUTORY_MAIL_FROM`). */
  readonly from: string;
  /** The marketing sender (`SHOUTORY_MAIL_MARKETING_FROM`); marketing mail is refused without a different one. */
  readonly marketingFrom?: string | undefined;
  /** The origin of the https unsubscribe URL; a worker may lack it, and then marketing mail is refused. */
  readonly publicOrigin?: string | undefined;
  readonly logger: Logger;
  /** The template registry. */
  readonly templates?: Readonly<Record<string, MailTemplate>>;
  readonly batch?: number;
  readonly intervalMs?: number;
  /** One send, from connect to the server's answer; a row is not started when this would pass its lease. */
  readonly sendTimeoutMs?: number;
  /** How long `stop` waits for a tick in flight. */
  readonly stopTimeoutMs?: number;
  /** The clock in milliseconds (AGENTS 3.10); the lease check reads it. */
  readonly now?: () => number;
}

export interface MailSender {
  /** Claims due mails, sends them and marks each; answers how many were sent. */
  tick(): Promise<number>;
  /** Ticks until stopped (an interval loop, like the relay). Once only. */
  start(): void;
  /** Stops the loop, waits a bounded time for a tick in flight and closes the transport. */
  stop(): Promise<void>;
}

interface Claimed {
  id: string;
  workspace_id: string | null;
  recipient: string;
  template: string;
  vars: unknown;
  link_ciphertext: Buffer | null;
  link_iv: Buffer | null;
  link_auth_tag: Buffer | null;
  link_wrap_iv: Buffer | null;
  link_wrap_tag: Buffer | null;
  link_wrapped_dek: Buffer | null;
  link_key_id: string | null;
  link_format_version: number | null;
  link_generation: number | null;
  attempts: number;
}

const DEFAULT_BATCH = 10;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;
/** The lease `email_outbox_claim` gives a row (migration 0012: five minutes). */
const LEASE_MS = 5 * 60_000;
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;

class SendTimeout extends Error {
  override readonly name = "SendTimeout";
}

/** The sealed link of a claimed row, opened under the AAD of the row; a row that lost its link cannot be sent. */
function openLink(row: Claimed, keys: KeyProvider): string {
  const { link_ciphertext: ciphertext, link_iv: iv, link_auth_tag: tag, link_wrap_iv: wrapIv } = row;
  const { link_wrap_tag: wrapTag, link_wrapped_dek: wrappedDek } = row;
  const { link_key_id: keyId, link_format_version: formatVersion, link_generation: generation } = row;
  if (!ciphertext || !iv || !tag || !wrapIv || !wrapTag || !wrappedDek || !keyId) {
    throw new Error("the mail row holds no sealed link");
  }
  if (formatVersion === null || generation === null) throw new Error("the mail row holds no sealed link");
  const stored: StoredSecret = { formatVersion, keyId, iv, ciphertext, tag, wrapIv, wrapTag, wrappedDek };
  const aad: Aad = emailLinkAad(row.id, row.workspace_id, generation);
  return open(stored, aad, keys).expose();
}

/** Runs the send under a timeout: on expiry the promise rejects first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SendTimeout("the SMTP send ran past its timeout")), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** A marketing mail the sender may not send; `reason` is one of a fixed few, never text from a row. */
class MarketingRefused extends Error {
  override readonly name = "MarketingRefused";
  constructor(readonly reason: "no_marketing_sender" | "same_sender" | "no_https_origin") {
    super("the marketing mail was refused before SMTP");
  }
}

const addressOf = (sender: string): string => (/<([^>]+)>/.exec(sender)?.[1] ?? sender).trim().toLowerCase();

interface Envelope {
  readonly from: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The sender and headers of one mail by its class (rule 100). Transactional mail uses `from` and carries no marketing
 * headers. Marketing mail needs its own sender and an https unsubscribe URL, and carries both List-Unsubscribe headers
 * (RFC 8058); any gap refuses it here, before an SMTP connection.
 */
function envelopeOf(options: MailSenderOptions, template: MailTemplate, recipient: string): Envelope {
  const { from, marketingFrom, publicOrigin, pepper } = options;
  if (template.class === "transactional") return { from };
  if (!marketingFrom) throw new MarketingRefused("no_marketing_sender");
  if (addressOf(marketingFrom) === addressOf(from)) throw new MarketingRefused("same_sender");
  if (!publicOrigin?.startsWith("https://")) throw new MarketingRefused("no_https_origin");
  const url = `${publicOrigin}/api/v1/unsubscribe/${unsubscribeToken(pepper, recipient)}`;
  return {
    from: marketingFrom,
    headers: {
      "List-Unsubscribe": `<${url}>, <mailto:${addressOf(marketingFrom)}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** The row id, the error class and a safe code: an SMTP answer may echo the message and its link, so no text (R323). */
function logFailure(logger: Logger, row: Claimed, error: unknown): void {
  if (error instanceof MarketingRefused) {
    logger.error({ id: row.id, reason: error.reason }, "marketing mail refused before SMTP");
    return;
  }
  const code = (error as { code?: unknown } | null)?.code;
  logger.error(
    {
      id: row.id,
      error: error instanceof Error ? error.name : "NonError",
      ...(typeof code === "string" && SAFE_CODE.test(code) ? { code } : {}),
    },
    "mail send failed",
  );
}

/** What one send needs: the options, the template registry and the SMTP transport, made on first use. */
interface Sending {
  readonly options: MailSenderOptions;
  readonly templates: Readonly<Record<string, MailTemplate>>;
  readonly sendTimeoutMs: number;
  transport(): Transporter;
}

async function send(ctx: Sending, row: Claimed): Promise<void> {
  const found = ctx.templates[row.template];
  if (!found) throw new Error("the mail template is not registered");
  // The guard runs before the link is opened: a refused mail never touches the sealed link or the network.
  const envelope = envelopeOf(ctx.options, found, row.recipient);
  const { subject, text } = found.render(openLink(row, ctx.options.keys), row.vars);
  await within(
    ctx.transport().sendMail({ ...envelope, to: row.recipient, subject, text }),
    ctx.sendTimeoutMs,
  );
}

/** Sends one claimed row and marks the attempt with the claim's fencing token; true when it was sent and marked. */
async function deliver(ctx: Sending, row: Claimed): Promise<boolean> {
  const { pool, logger } = ctx.options;
  let ok = true;
  try {
    await send(ctx, row);
  } catch (error) {
    ok = false;
    logFailure(logger, row, error);
  }
  const marked = await withSystem(pool, "mail_sender", (tx) =>
    tx.query<{ ok: boolean }>("SELECT app.email_outbox_mark($1, $2, $3) AS ok", [row.id, row.attempts, ok]),
  );
  if (!marked.rows[0]?.ok) logger.warn({ id: row.id }, "mail claim was lost before the mark");
  return ok && marked.rows[0]?.ok === true;
}

/**
 * Drains `email_outbox`. A claim is a short transaction that leases the rows; the SMTP send runs after it ended
 * (AGENTS 3.7); the mark names the attempt the claim handed out. The link is opened only here, once per attempt, and
 * the mark erases it on a send. Rows are sent one by one, so a later row could outlive the lease of the claim: the
 * batch stops before a row whose send could pass it (the rows return when the lease lapses), and after a stop no
 * further row starts (R325).
 */
export function createMailSender(options: MailSenderOptions): MailSender {
  const { pool, logger, batch = DEFAULT_BATCH, now = Date.now } = options;
  const { sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS } = options;
  let transport: Transporter | undefined;
  const ctx: Sending = {
    options,
    templates: options.templates ?? TEMPLATES,
    sendTimeoutMs,
    transport: () => {
      transport ??= createTransport({
        url: options.smtpUrl.expose(),
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: CONNECT_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
      });
      return transport;
    },
  };
  let stopped = false;

  async function tick(): Promise<number> {
    const claimed = await withSystem(pool, "mail_sender", (tx) =>
      tx.query<Claimed>("SELECT * FROM app.email_outbox_claim($1)", [batch]),
    );
    const claimedAt = now();
    let sent = 0;
    for (const row of claimed.rows) {
      if (stopped) break;
      if (now() - claimedAt + sendTimeoutMs > LEASE_MS) {
        logger.warn({ id: row.id }, "mail batch stopped before the claim lease could lapse");
        break;
      }
      if (await deliver(ctx, row)) sent += 1;
    }
    return sent;
  }

  const { intervalMs = DEFAULT_INTERVAL_MS, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS } = options;
  const loop = intervalLoop("mail sender", tick, logger, intervalMs, stopTimeoutMs);
  return {
    tick,
    start: loop.start,
    async stop() {
      stopped = true;
      await loop.stop();
      transport?.close();
    },
  };
}
