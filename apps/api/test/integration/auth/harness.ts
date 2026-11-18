import { open, SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import { EnvKeyProvider } from "@shoutory/core/keys";
import { createAppPool, createAuthDb } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import { inject } from "vitest";
import { createApp } from "../../../src/app.js";
import { createAuth } from "../../../src/auth/auth.js";
import { createLogger } from "../../../src/logging/logger.js";
import { emailLinkAad } from "../../../src/mail/enqueue.js";

export const env = readTestEnv();
export const ORIGIN = "https://app.example.test";
export const PASSWORD = "password-test-1234";
export const SECRET = "session-secret-for-tests-0123456789abcdef";
export const PEPPER = "auth-pepper-for-tests-0123456789abcdef";

export const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

/** The headers of a same-origin request from the web client. */
export const WEB = {
  "sec-fetch-site": "same-origin",
  "x-shoutory-client": "web",
  origin: ORIGIN,
  "content-type": "application/json",
};

// Each call gets its own peer address unless a test pins one, so the per-IP buckets never couple two tests.
let nextHost = 1;
export const freshPeer = (): string => `192.0.2.${(nextHost++ % 250) + 1}`;
const remote = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

type AdminClient = Parameters<Parameters<typeof withAdminClient>[2]>[0];

export interface Mail {
  readonly recipient: string;
  readonly template: string;
  readonly link: string;
}

export interface Fixture {
  readonly db: TestDatabase;
  readonly logged: string[];
  /** Builds an app whose library runs on the given pool URL (a dead URL simulates its database failing). */
  appOn(authUrl: string): ReturnType<typeof createApp>;
  readonly app: ReturnType<typeof createApp>;
  request(
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string>; peer?: string },
    app?: ReturnType<typeof createApp>,
  ): Promise<Response>;
  /** The mails queued for `recipient`, newest first, with the sealed link opened. */
  mails(recipient: string): Promise<Mail[]>;
  admin<T>(run: (client: AdminClient) => Promise<T>): Promise<T>;
  /** Signs up, verifies through the mailed token and signs in; returns the session cookie. */
  signedIn(email: string, peer?: string): Promise<string>;
  close(): Promise<void>;
}

export const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");

export function tokenOf(mail: Mail | undefined): string {
  if (!mail) throw new Error("no mail was queued");
  return new URL(mail.link).hash.replace(/^#token=/, "");
}

type RequestInitLike = Parameters<Fixture["request"]>[1];

const send = (app: ReturnType<typeof createApp>, path: string, init: RequestInitLike = {}) =>
  Promise.resolve(
    app.request(
      path,
      {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { ...WEB, ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      remote(init.peer ?? freshPeer()),
    ),
  );

// An outbox row with its sealed link opened under the test key ring.
interface OutboxRow {
  id: string;
  workspace_id: string | null;
  template: string;
  link_format_version: number;
  link_key_id: string;
  link_iv: Buffer;
  link_ciphertext: Buffer;
  link_auth_tag: Buffer;
  link_wrap_iv: Buffer;
  link_wrap_tag: Buffer;
  link_wrapped_dek: Buffer;
  link_generation: number;
}

function openedMail(recipient: string, row: OutboxRow): Mail {
  const stored: StoredSecret = {
    formatVersion: row.link_format_version,
    keyId: row.link_key_id,
    iv: row.link_iv,
    ciphertext: row.link_ciphertext,
    tag: row.link_auth_tag,
    wrapIv: row.link_wrap_iv,
    wrapTag: row.link_wrap_tag,
    wrappedDek: row.link_wrapped_dek,
  };
  const aad = emailLinkAad(row.id, row.workspace_id, row.link_generation);
  return { recipient, template: row.template, link: open(stored, aad, keys).expose() };
}

// Signs up, verifies through the mailed token and signs in; the session cookie.
async function verifiedSession(
  { request, mails }: Pick<Fixture, "request" | "mails">,
  email: string,
  peer: string,
): Promise<string> {
  await request("/api/auth/sign-up/email", { body: { name: "Test", email, password: PASSWORD }, peer });
  const [mail] = await mails(email);
  await request("/api/auth/verify-email", { body: { token: tokenOf(mail) }, peer });
  const answer = await request("/api/auth/sign-in/email", { body: { email, password: PASSWORD }, peer });
  return cookieOf(answer);
}

export interface FixtureOptions {
  /** A pepper that misbehaves, to force a failure inside a database hook. */
  readonly pepper?: SealedSecret;
  /** Values the logger must mask, as the real process registers its secrets. */
  readonly secrets?: readonly string[];
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = await cloneTemplate(env, inject("shoutoryTemplate"));
  const logged: string[] = [];
  const logger = createLogger({
    secrets: [SECRET, PEPPER, ...(options.secrets ?? [])],
    stream: { write: (line) => void logged.push(line) },
  });
  const authPool = db.pool("auth");
  const appPool = db.pool("app");
  // The clone's own pools are closed by `db.drop()`; only the pools made here for an outage are ended here.
  const extraPools: (typeof authPool)[] = [];
  // A library URL replaces only the library's database: the throttle, the mail queue and the owner claim keep the
  // live pool, so a request still reaches the library before its database fails.
  const buildApp = (libraryUrl: string | undefined) => {
    const libraryPool = libraryUrl ? createAppPool(libraryUrl, () => undefined) : authPool;
    if (libraryUrl) extraPools.push(libraryPool);
    const auth = createAuth({
      publicOrigin: ORIGIN,
      secret: SECRET,
      pepper: options.pepper ?? new SealedSecret(PEPPER),
      keys,
      db: createAuthDb(libraryPool),
      pool: authPool,
      logger,
    });
    return createApp({ publicOrigin: ORIGIN, trustedProxies: [], pool: appPool, keys, logger, auth });
  };
  const app = buildApp(undefined);
  const request: Fixture["request"] = (path, init, on = app) => send(on, path, init);
  const admin: Fixture["admin"] = (run) => withAdminClient(env, db.name, run);
  const mails: Fixture["mails"] = (recipient) =>
    admin(async (client) => {
      const found = await client.query(
        "SELECT * FROM app.email_outbox WHERE recipient = $1 ORDER BY created_at DESC",
        [recipient],
      );
      return found.rows.map((row) => openedMail(recipient, row));
    });
  const signedIn: Fixture["signedIn"] = (email, peer = freshPeer()) =>
    verifiedSession({ request, mails }, email, peer);
  return {
    db,
    logged,
    app,
    appOn: buildApp,
    request,
    mails,
    admin,
    signedIn,
    close: async () => {
      await Promise.all(extraPools.map((pool) => pool.end()));
      await db.drop();
    },
  };
}
