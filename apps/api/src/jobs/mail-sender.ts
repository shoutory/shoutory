import { type Aad, open, type SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import type { KeyProvider } from "@shoutory/core/keys";
import { withSystem } from "@shoutory/db/context/system";
import type { AppPool } from "@shoutory/db/pool";
import { createTransport, type Transporter } from "nodemailer";
import type { Logger } from "../logging/logger.js";
import { emailLinkAad } from "../mail/enqueue.js";
import { type MailTemplate, mailLocale, TEMPLATES } from "../mail/templates.js";
import { unsubscribeToken } from "../routes/unsubscribe.js";
import { intervalLoop } from "./outbox-relay.js";

export interface MailSenderOptions {
  readonly pool: AppPool;
  readonly keys: KeyProvider;
  readonly pepper: SealedSecret;
  readonly smtpUrl: SealedSecret;
  readonly from: string;
  // Marketing mail is refused without a sender different from `from`.
  readonly marketingFrom?: string | undefined;
  // A worker may lack it, and then marketing mail is refused.
  readonly publicOrigin?: string | undefined;
  readonly logger: Logger;
  readonly templates?: Readonly<Record<string, MailTemplate>>;
  readonly batch?: number;
  readonly intervalMs?: number;
  // A row is not started when its send could pass the lease.
  readonly sendTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly now?: () => number;
}

export interface MailSender {
  tick(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

interface Claimed {
  id: string;
  workspace_id: string | null;
  recipient: string;
  template: string;
  locale: string;
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
// The lease `email_outbox_claim` gives a row: five minutes.
const LEASE_MS = 5 * 60_000;
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;

class SendTimeout extends Error {
  override readonly name = "SendTimeout";
}

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

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SendTimeout("the SMTP send ran past its timeout")), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// `reason` is one of a fixed few, never text from a row.
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

// Marketing mail needs its own sender and an https unsubscribe URL (both List-Unsubscribe headers, RFC 8058); any gap
// refuses it here, before an SMTP connection.
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

// Only the row id, the error class and a safe code: an SMTP answer may echo the message and its link.
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
  const link = found.sealedLink ? openLink(row, ctx.options.keys) : "";
  const { subject, text } = found.render(mailLocale(row.locale), link, row.vars);
  await within(
    ctx.transport().sendMail({ ...envelope, to: row.recipient, subject, text }),
    ctx.sendTimeoutMs,
  );
}

// The link is opened only inside send, once per attempt, and the mark erases it.
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

// The SMTP send runs after the claim transaction ended (no external call inside a transaction). Rows are sent one by
// one, so a later row could outlive the lease: the batch stops before a row whose send could pass it, and the rows
// return when the lease lapses.
export function createMailSender(options: MailSenderOptions): MailSender {
  const { pool, logger, batch = DEFAULT_BATCH, now = Date.now } = options;
  const { sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS } = options;
  let transport: Transporter | undefined;
  const ctx: Sending = {
    options,
    templates: options.templates ?? TEMPLATES,
    sendTimeoutMs,
    transport: () => {
      const url = options.smtpUrl.expose();
      // A plain smtp: URL must upgrade with STARTTLS; `?requireTLS=false` in the URL opts out (it wins over this).
      transport ??= createTransport({
        url,
        requireTLS: new URL(url).protocol === "smtp:",
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
      // After a stop no further row starts.
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
