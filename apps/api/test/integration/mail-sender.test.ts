import { createHmac } from "node:crypto";
import { SealedSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createMailSender, type MailSenderOptions } from "../../src/jobs/mail-sender.js";
import { createLogger } from "../../src/logging/logger.js";
import { enqueueMail } from "../../src/mail/enqueue.js";
import { TEMPLATE_NAMES, TEMPLATES } from "../../src/mail/templates.js";
import { type SmtpSink, startSmtpSink } from "../support/smtp-sink.js";

const env = readTestEnv();
const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});
const PEPPER = "sender-pepper-for-tests-0123456789ab";
const pepper = new SealedSecret(PEPPER);
const FROM = "Shoutory <noreply@mail.example.test>";
const MARKETING_FROM = "Shoutory News <news@news.example.test>";
const ORIGIN = "https://app.example.test";
// Characters that spell differently in every form the canary is searched for.
const CANARY_LINK = 'https://app.example.test/auth/verify#token=canary+/="v\\1 a&b';
const PLAIN_LINK = "https://app.example.test/auth/verify#token=plain-link-1";
const SEALED = [
  "link_ciphertext",
  "link_iv",
  "link_auth_tag",
  "link_wrap_iv",
  "link_wrap_tag",
  "link_wrapped_dek",
  "link_key_id",
  "link_format_version",
  "link_generation",
];

const spellings = (v: string): [string, Buffer][] => [
  ["raw", Buffer.from(v)],
  ["percent-encoded", Buffer.from(encodeURIComponent(v))],
  ["hex", Buffer.from(Buffer.from(v).toString("hex"))],
  ["base64", Buffer.from(Buffer.from(v).toString("base64"))],
  ["JSON-escaped", Buffer.from(JSON.stringify(v).slice(1, -1))],
];
const emailDigest = (address: string) =>
  createHmac("sha256", Buffer.from(PEPPER))
    .update(`email_suppression:${address.toLowerCase()}`)
    .digest("hex");
const tokenOf = (address: string) => {
  const digest = emailDigest(address);
  const mac = createHmac("sha256", Buffer.from(PEPPER)).update(`unsubscribe:${digest}`).digest();
  return `${Buffer.from(digest, "hex").toString("base64url")}.${mac.toString("base64url")}`;
};

let db: TestDatabase;
let sink: SmtpSink;
let lines: string[];
beforeAll(async () => {
  db = await cloneTemplate(env, inject("shoutoryTemplate"));
});
afterAll(() => db.drop());
beforeEach(async () => {
  sink = await startSmtpSink();
  lines = [];
});
afterEach(() => sink.close());

const sender = (extra: Partial<MailSenderOptions> = {}) =>
  createMailSender({
    pool: db.pool("worker"),
    keys,
    pepper,
    smtpUrl: new SealedSecret(sink.url),
    from: FROM,
    publicOrigin: ORIGIN,
    logger: createLogger({ secrets: [], stream: { write: (line) => void lines.push(line) } }),
    ...extra,
  });
let counter = 0;
const queue = (link: string, template = "verify_email" as (typeof TEMPLATE_NAMES)[number], vars = {}) =>
  enqueueMail(
    db.pool("app"),
    { workspaceId: null, recipient: `sender-${++counter}@example.test`, template, locale: "en", vars, link },
    { keys, pepper },
  );
const row = (id: string) =>
  withAdminClient(env, db.name, async (admin) => {
    const found = await admin.query("SELECT * FROM app.email_outbox WHERE id = $1", [id]);
    return found.rows[0] as Record<string, unknown>;
  });
const recipientOf = async (id: string) => String((await row(id)).recipient);
// Only this test's mail may be due, so every test drains the outbox first.
const drain = () => withAdminClient(env, db.name, (admin) => admin.query("DELETE FROM app.email_outbox"));
beforeEach(drain);

describe("the mail sender", () => {
  it("email_outbox row holds the link only sealed; after send only digest remains", async () => {
    const id = await queue(PLAIN_LINK);
    expect((await row(id)).link_ciphertext).toBeInstanceOf(Buffer);
    expect(await sender().tick()).toBe(1);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toContain(PLAIN_LINK);
    const after = await row(id);
    expect([after.state, after.attempts]).toEqual(["sent", 1]);
    for (const column of SEALED) expect(after[column], column).toBeNull();
    const digest = createHmac("sha256", Buffer.from(PEPPER)).update(`email_link:${PLAIN_LINK}`).digest("hex");
    expect(after.link_digest).toBe(digest);
  });

  it("a failed send keeps the sealed link and the retry delivers the same link", async () => {
    const id = await queue(PLAIN_LINK);
    sink.reject = true;
    expect(await sender().tick()).toBe(0);
    const failed = await row(id);
    expect([failed.state, failed.attempts]).toEqual(["pending", 1]);
    expect(failed.link_ciphertext).toBeInstanceOf(Buffer);
    sink.reject = false;
    await withAdminClient(env, db.name, (a) =>
      a.query("UPDATE app.email_outbox SET next_attempt_at = now()"),
    );
    expect(await sender().tick()).toBe(1);
    expect(sink.messages[0]).toContain(PLAIN_LINK);
    expect((await row(id)).state).toBe("sent");
  });
});

describe("STARTTLS for smtp: URLs (R493)", () => {
  it.each(["smtp://", "SMTP://", "Smtp://"])(
    "a %s URL to a server without STARTTLS is not delivered",
    async (scheme) => {
      await queue(PLAIN_LINK);
      const plain = (sink.url.split("?")[0] as string).replace(/^smtp:\/\//i, scheme);
      expect(await sender({ smtpUrl: new SealedSecret(plain) }).tick()).toBe(0);
      expect(sink.messages).toHaveLength(0);
    },
  );

  it("an smtp: URL to a server without STARTTLS is not delivered; with ?requireTLS=false it is", async () => {
    const id = await queue(PLAIN_LINK);
    const plain = sink.url.split("?")[0] as string;
    expect(await sender({ smtpUrl: new SealedSecret(plain) }).tick()).toBe(0);
    expect(sink.messages).toHaveLength(0);
    await withAdminClient(env, db.name, (a) =>
      a.query("UPDATE app.email_outbox SET next_attempt_at = now()"),
    );
    expect(await sender({ smtpUrl: new SealedSecret(`${plain}?requireTLS=false`) }).tick()).toBe(1);
    expect(sink.messages).toHaveLength(1);
    expect((await row(id)).state).toBe("sent");
  });
});

const LEASE_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 100 && !done(); tries++) await sleep(20);
};

describe("the batch loop (R325)", () => {
  it.each([
    [
      "a hanging server ends as a failed attempt by the send timeout",
      async () => {
        const id = await queue(PLAIN_LINK);
        sink.hold = true;
        expect(await sender({ sendTimeoutMs: 100 }).tick()).toBe(0);
        const after = await row(id);
        expect([after.state, after.attempts]).toEqual(["pending", 1]);
        expect(lines.some((line) => line.includes("SendTimeout"))).toBe(true);
      },
    ],
    [
      "a stop during a send starts no further row of the batch",
      async () => {
        await queue(PLAIN_LINK);
        await queue(PLAIN_LINK);
        sink.hold = true;
        const running = sender({ intervalMs: 10, stopTimeoutMs: 20 });
        running.start();
        await until(() => sink.connections === 1);
        await running.stop();
        sink.release();
        await sleep(300);
        expect(sink.connections).toBe(1);
      },
    ],
    [
      "a row that would outlive its lease is not sent",
      async () => {
        const first = await queue(PLAIN_LINK);
        const second = await queue(PLAIN_LINK);
        const clock = { t: 0 };
        // The first send takes the whole lease: the second row would be sent after the lease lapsed.
        sink.onMessage = () => {
          clock.t = LEASE_MS;
        };
        expect(await sender({ now: () => clock.t }).tick()).toBe(1);
        expect((await row(first)).state).toBe("sent");
        const left = await row(second);
        expect([left.state, left.attempts, sink.messages.length]).toEqual(["sending", 1, 1]);
      },
    ],
  ])("%s", async (_name, scenario) => {
    await scenario();
  });
});

describe("the canary link of a failed send (AGENTS 4.2)", () => {
  let failedId = "";
  let everything = Buffer.alloc(0);
  beforeEach(async () => {
    failedId = await queue(CANARY_LINK);
    // The server echoes the whole message in its refusal: the worst a provider can do.
    sink.reject = true;
    expect(await sender().tick()).toBe(0);
    const failed = await row(failedId);
    expect([sink.connections, failed.attempts]).toEqual([1, 1]);
    everything = Buffer.concat(
      Object.values(failed).map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v) ?? ""))),
    );
  });
  const failureLine = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((l) => l.error);

  it.each(spellings(CANARY_LINK))(
    "is absent from logs, the failure line and rows in its %s form",
    (_form, bytes) => {
      expect(lines.length).toBeGreaterThan(0);
      expect(Buffer.from(lines.join("\n")).includes(bytes)).toBe(false);
      expect(Buffer.from(JSON.stringify(failureLine())).includes(bytes)).toBe(false);
      expect(everything.includes(bytes)).toBe(false);
    },
  );

  it("logs the failure by id, error name and code only", () => {
    const failure = failureLine();
    expect(failure).toMatchObject({ id: failedId, error: "Error", code: "EMESSAGE" });
    expect(failure).not.toHaveProperty("err");
  });
});

describe("mail classes (rule 100)", () => {
  const marketing = {
    templates: { ...TEMPLATES, verify_email: { ...TEMPLATES.verify_email, class: "marketing" as const } },
  };

  it.each([
    ["no marketing sender is set", { marketingFrom: undefined }],
    ["the marketing sender is the transactional sender", { marketingFrom: FROM }],
    [
      "no public origin gives no https unsubscribe URL",
      { marketingFrom: MARKETING_FROM, publicOrigin: undefined },
    ],
  ])("refuses a marketing mail before any SMTP connection when %s", async (_name, extra) => {
    const id = await queue(PLAIN_LINK);
    expect(await sender({ ...marketing, ...extra }).tick()).toBe(0);
    expect(sink.connections).toBe(0);
    const after = await row(id);
    expect([after.state, after.attempts]).toEqual(["pending", 1]);
    expect(lines.some((line) => line.includes("marketing"))).toBe(true);
  });

  it("sends a marketing mail from the marketing sender with both unsubscribe headers and the recipient's token", async () => {
    const id = await queue(PLAIN_LINK);
    expect(await sender({ ...marketing, marketingFrom: MARKETING_FROM }).tick()).toBe(1);
    const message = sink.messages[0] ?? "";
    expect(message).toMatch(/^From: .*news@news\.example\.test/im);
    const token = tokenOf(await recipientOf(id));
    expect(message).toContain(
      `List-Unsubscribe: <${ORIGIN}/api/v1/unsubscribe/${token}>, <mailto:news@news.example.test`,
    );
    expect(message).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  });

  it.each(TEMPLATE_NAMES)(
    "the %s template is transactional: it uses SHOUTORY_MAIL_FROM, has no unsubscribe header and ignores a suppression",
    async (template) => {
      expect(TEMPLATES[template].class).toBe("transactional");
      const vars = template === "invitation" ? { workspaceName: "Studio", role: "editor" } : {};
      const id = await queue(PLAIN_LINK, template, vars);
      await db
        .pool("worker")
        .query("SELECT app.email_suppression_add($1, 'unsubscribe')", [emailDigest(await recipientOf(id))]);
      expect(await sender({ marketingFrom: MARKETING_FROM }).tick()).toBe(1);
      const message = sink.messages[0] ?? "";
      expect(message).toMatch(/^From: .*noreply@mail\.example\.test/im);
      expect(message).not.toMatch(/^List-Unsubscribe/im);
      expect(message).toMatch(/^Subject: \S/m);
      expect(message).toContain(PLAIN_LINK);
    },
  );
});
