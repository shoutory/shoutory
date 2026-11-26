import { createHash, createHmac } from "node:crypto";
import { open, SealedSecret, type StoredSecret } from "@shoutory/core/crypto";
import type { Entitlements } from "@shoutory/core/entitlements";
import { EnvKeyProvider } from "@shoutory/core/keys";
import type { StorageDriver } from "@shoutory/core/storage";
import { createAppPool, createAuthDb } from "@shoutory/db/pool";
import { cloneTemplate, readTestEnv, type TestDatabase, withAdminClient } from "@shoutory/db/testing";
import type { EgressRequest, EgressResponse } from "@shoutory/provider-sdk/egress";
import { EgressError } from "@shoutory/provider-sdk/egress/errors";
import { inject } from "vitest";
import { type AppOptions, createApp } from "../../../src/app.js";
import { type AuthService, createAuth } from "../../../src/auth/auth.js";
import { createLogger } from "../../../src/logging/logger.js";
import { emailLinkAad } from "../../../src/mail/enqueue.js";

export const env = readTestEnv();
export const ORIGIN = "https://app.example.test";
export const PASSWORD = "password-test-1234";

// One valid-looking body per non-GET path of the authentication mount, so a refusal is the guard's and not the schema's.
export const SAMPLE: Record<string, unknown> = {
  "/api/auth/sign-up/email": { name: "Test", email: "table-1@example.test", password: PASSWORD },
  "/api/auth/sign-in/email": { email: "table-1@example.test", password: PASSWORD },
  "/api/auth/sign-out": {},
  "/api/auth/send-verification-email": { email: "table-1@example.test" },
  "/api/auth/verify-email": { token: "token-sample-1" },
  "/api/auth/sessions/revoke": { id: "00000000-0000-7000-8000-000000000001" },
  "/api/auth/sessions/revoke-others": {},
  "/api/auth/profile": { name: "Test" },
  "/api/auth/verify-password": { password: PASSWORD },
  "/api/auth/change-password": { currentPassword: PASSWORD, newPassword: "another-password-5678" },
  "/api/auth/request-password-reset": { email: "table-1@example.test" },
  "/api/auth/reset-password": { token: "token-sample-1", newPassword: "another-password-5678" },
  "/api/auth/two-factor/enable": { password: PASSWORD },
  "/api/auth/two-factor/disable": { password: PASSWORD },
  "/api/auth/two-factor/get-totp-uri": { password: PASSWORD },
  "/api/auth/two-factor/generate-backup-codes": { password: PASSWORD },
  "/api/auth/two-factor/verify-totp": { code: "123456" },
  "/api/auth/two-factor/verify-backup-code": { code: "backup-sample-1" },
};
export const SECRET = "session-secret-for-tests-0123456789abcdef";
export const PEPPER = "auth-pepper-for-tests-0123456789abcdef";

export const keys = new EnvKeyProvider({
  SHOUTORY_ACTIVE_KEY_ID: "k1",
  SHOUTORY_KEK_K1: Buffer.alloc(32, 1).toString("base64"),
});

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
  readonly locale: string;
  readonly link: string;
}

export interface Fixture {
  readonly db: TestDatabase;
  readonly logged: string[];
  /** Builds an app whose library runs on the given pool URL (a dead URL simulates its database failing). */
  appOn(authUrl: string): ReturnType<typeof createApp>;
  readonly app: ReturnType<typeof createApp>;
  readonly auth: AuthService;
  request(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      peer?: string;
      signal?: AbortSignal;
    },
    app?: ReturnType<typeof createApp>,
  ): Promise<Response>;
  mails(recipient: string): Promise<Mail[]>;
  admin<T>(run: (client: AdminClient) => Promise<T>): Promise<T>;
  signedIn(email: string, peer?: string): Promise<string>;
  readonly hibp: HibpFake;
  enrolled(email: string): Promise<Enrolled>;
  /** Signs in a user with a second factor and returns the jar that holds only the challenge cookie. */
  challenged(email: string): Promise<{ jar: Jar; answer: Response }>;
  sessionCount(email: string): Promise<number>;
  close(): Promise<void>;
}

export interface Enrolled {
  readonly email: string;
  readonly jar: Jar;
  readonly secret: string;
  readonly backupCodes: string[];
  readonly enableAnswer: Response;
}

export interface HibpFake {
  readonly breached: Set<string>;
  readonly urls: string[];
  down: boolean;
  /** When set, the whole answer body, whatever the range asked for. */
  body: string | undefined;
  readonly fetch: (request: EgressRequest) => Promise<EgressResponse>;
}

export function createHibpFake(): HibpFake {
  const fake: HibpFake = {
    breached: new Set(),
    urls: [],
    down: false,
    body: undefined,
    fetch: async ({ url }) => {
      fake.urls.push(url);
      if (fake.down) throw new EgressError({ class: "connect", host: new URL(url).hostname });
      const answer = (text: string): EgressResponse => ({
        status: 200,
        headers: {},
        body: new TextEncoder().encode(text),
      });
      if (fake.body !== undefined) return answer(fake.body);
      const prefix = new URL(url).pathname.split("/").pop() ?? "";
      const lines = [...fake.breached]
        .map((password) => createHash("sha1").update(password.normalize("NFKC")).digest("hex").toUpperCase())
        .filter((hash) => hash.startsWith(prefix.toUpperCase()))
        .map((hash) => `${hash.slice(5)}:3`);
      return answer([...lines, "0000000000000000000000000000000000A:0"].join("\r\n"));
    },
  };
  return fake;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, steps = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps));
  const hash = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (hash[19] ?? 0) & 15;
  const number =
    (((hash[offset] ?? 0) & 127) << 24) |
    ((hash[offset + 1] ?? 0) << 16) |
    ((hash[offset + 2] ?? 0) << 8) |
    (hash[offset + 3] ?? 0);
  return String(number % 1_000_000).padStart(6, "0");
}

/** The cookies a browser would hold: a Set-Cookie with an empty value or a zero Max-Age removes the cookie. */
export class Jar {
  private readonly cookies = new Map<string, string>();
  constructor(header = "") {
    for (const pair of header.split(";")) {
      const [name = "", ...value] = pair.trim().split("=");
      if (name && value.join("=")) this.cookies.set(name, value.join("="));
    }
  }
  add(response: Response): this {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const [name = "", ...value] = pair.split("=");
      const gone = value.join("=") === "" || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (gone) this.cookies.delete(name);
      else this.cookies.set(name, value.join("="));
    }
    return this;
  }
  get header(): Record<string, string> {
    return { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }
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
        ...(init.signal === undefined ? {} : { signal: init.signal }),
      },
      remote(init.peer ?? freshPeer()),
    ),
  );

interface OutboxRow {
  id: string;
  workspace_id: string | null;
  template: string;
  locale: string;
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
  return { recipient, template: row.template, locale: row.locale, link: open(stored, aad, keys).expose() };
}

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
  readonly pepper?: SealedSecret;
  readonly secrets?: readonly string[];
  /** Sign-up is open to anyone unless a test says `false`: the first verified user closes it by becoming the owner. */
  readonly signupOpen?: boolean;
  readonly now?: () => number;
  /** The storage driver of the app; absent, the app has no storage routes. */
  readonly storage?: StorageDriver;
  /** The upload-URL signer of the app; absent, the app has no register or complete routes. */
  readonly presigner?: AppOptions["presigner"];
  /** The server side of S3 multipart uploads; absent, a file above 64 MiB is refused. */
  readonly multipart?: AppOptions["multipart"];
  /** The egress fetch of the import of media by URL; absent, the app has no import route. */
  readonly mediaImportFetch?: AppOptions["mediaImportFetch"];
  /** The most bytes one workspace may store; absent, no cap. */
  readonly mediaWorkspaceMaxBytes?: number;
  /** The folder the profile picture decoder works in; absent, the app has no profile picture routes. */
  readonly scratchDir?: string;
  /** The plan limits of the app; absent, the app answers the core self-host value. */
  readonly entitlements?: Entitlements;
  /** The providers and egress client of the channel check; absent, the app has no check route. */
  readonly channels?: AppOptions["channels"];
}

const mailsOf =
  (admin: Fixture["admin"]): Fixture["mails"] =>
  (recipient) =>
    admin(async (client) => {
      const found = await client.query(
        "SELECT * FROM app.email_outbox WHERE recipient = $1 ORDER BY created_at DESC",
        [recipient],
      );
      return found.rows.map((row) => openedMail(recipient, row));
    });

function accountHelpers({
  request,
  admin,
  signedIn,
}: Pick<Fixture, "request" | "admin" | "signedIn">): Pick<
  Fixture,
  "enrolled" | "challenged" | "sessionCount"
> {
  return {
    sessionCount: (email) =>
      admin(async (client) =>
        Number(
          (
            await client.query(
              'SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1',
              [email],
            )
          ).rows[0].count,
        ),
      ),
    enrolled: async (email) => {
      const jar = new Jar(await signedIn(email));
      const enableAnswer = await request("/api/auth/two-factor/enable", {
        body: { password: PASSWORD },
        headers: jar.header,
      });
      const body = (await enableAnswer.clone().json()) as { totpURI: string; backupCodes: string[] };
      const secret = new URL(body.totpURI).searchParams.get("secret") ?? "";
      const verified = await request("/api/auth/two-factor/verify-totp", {
        body: { code: totpAt(secret) },
        headers: jar.header,
      });
      jar.add(verified);
      return { email, jar, secret, backupCodes: body.backupCodes, enableAnswer };
    },
    challenged: async (email) => {
      const answer = await request("/api/auth/sign-in/email", { body: { email, password: PASSWORD } });
      return { jar: new Jar().add(answer), answer };
    },
  };
}

const openSignup = (database: string) =>
  withAdminClient(env, database, (client) =>
    client.query("INSERT INTO app.instance_settings (key, value) VALUES ('signup_enabled', 'true'::jsonb)"),
  );

interface Parts {
  readonly logger: ReturnType<typeof createLogger>;
  readonly hibp: HibpFake;
  readonly authPool: ReturnType<TestDatabase["pool"]>;
  readonly appPool: ReturnType<TestDatabase["pool"]>;
  readonly options: FixtureOptions;
}

function buildOn({ logger, hibp, authPool, appPool, options }: Parts, libraryPool: Parts["authPool"]) {
  // The same clock serves the app's caches and the session cap; absent, both read the system clock.
  const authClock = options.now ? { now: options.now } : {};
  const auth = createAuth({
    ...authClock,
    publicOrigin: ORIGIN,
    secret: SECRET,
    pepper: options.pepper ?? new SealedSecret(PEPPER),
    keys,
    db: createAuthDb(libraryPool),
    pool: authPool,
    appPool,
    fetch: hibp.fetch,
    logger,
  });
  const clock = options.now ? { now: options.now } : {};
  const storage = options.storage ? { storage: options.storage } : {};
  const signer = options.presigner ? { presigner: options.presigner } : {};
  const parts = options.multipart ? { multipart: options.multipart } : {};
  const imports = options.mediaImportFetch ? { mediaImportFetch: options.mediaImportFetch } : {};
  const limits = options.entitlements ? { entitlements: options.entitlements } : {};
  const channels = options.channels ? { channels: options.channels } : {};
  const cap = options.mediaWorkspaceMaxBytes
    ? { mediaWorkspaceMaxBytes: options.mediaWorkspaceMaxBytes }
    : {};
  const scratch = options.scratchDir ? { scratchDir: options.scratchDir } : {};
  const app = createApp({
    publicOrigin: ORIGIN,
    trustedProxies: [],
    pool: appPool,
    keys,
    logger,
    auth,
    ...clock,
    ...storage,
    ...signer,
    ...parts,
    ...imports,
    ...limits,
    ...channels,
    ...cap,
    ...scratch,
  });
  return { app, auth };
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = await cloneTemplate(env, inject("shoutoryTemplate"));
  if (options.signupOpen !== false) await openSignup(db.name);
  const logged: string[] = [];
  const logger = createLogger({
    secrets: [SECRET, PEPPER, ...(options.secrets ?? [])],
    stream: { write: (line) => void logged.push(line) },
  });
  const authPool = db.pool("auth");
  const appPool = db.pool("app");
  const hibp = createHibpFake();
  // The clone's own pools are closed by `db.drop()`; only the pools made here for an outage are ended here.
  const extraPools: (typeof authPool)[] = [];
  // A library URL replaces only the library's database: the throttle, the mail queue and the owner claim keep the
  // live pool, so a request still reaches the library before its database fails.
  const make = (libraryUrl: string | undefined) => {
    const libraryPool = libraryUrl ? createAppPool(libraryUrl, () => undefined) : authPool;
    if (libraryUrl) extraPools.push(libraryPool);
    return buildOn({ logger, hibp, authPool, appPool, options }, libraryPool);
  };
  const buildApp = (libraryUrl: string | undefined) => make(libraryUrl).app;
  const { app, auth } = make(undefined);
  const request: Fixture["request"] = (path, init, on = app) => send(on, path, init);
  const admin: Fixture["admin"] = (run) => withAdminClient(env, db.name, run);
  const mails = mailsOf(admin);
  const signedIn: Fixture["signedIn"] = (email, peer = freshPeer()) =>
    verifiedSession({ request, mails }, email, peer);
  return {
    db,
    logged,
    app,
    auth,
    appOn: buildApp,
    request,
    mails,
    admin,
    signedIn,
    hibp,
    ...accountHelpers({ request, admin, signedIn }),
    close: async () => {
      await Promise.all(extraPools.map((pool) => pool.end()));
      await db.drop();
    },
  };
}
