import { isIP } from "node:net";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { SealedSecret } from "../crypto/envelope.js";
import { EnvKeyProvider, KeyError, type KeyProvider } from "../crypto/keys.js";
import { isMetadataOrLinkLocal } from "../net/address.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** A start-up refusal; `variable` names the setting and the message never carries its value. */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

const ROLES = ["owner", "app", "worker", "auth", "readonly"] as const;
type Role = (typeof ROLES)[number];
const SECRET_FLOOR_BYTES = 32;

// Example values the README and the compose notes show. A secret equal to one is refused in every mode;
// each is format-valid, so only this list can refuse it.
const KNOWN_DEFAULTS: ReadonlySet<string> = new Set([
  "c2hvdXRvcnktZXhhbXBsZS1rZWstMDEyMzQ1Njc4OSE=",
  "example-pepper-do-not-use-in-production-0001",
  "example-session-secret-do-not-use-in-production-0001",
  ...ROLES.map((role) => `${role}-dev-password`),
]);

const notDefault = (value: string) => !KNOWN_DEFAULTS.has(value);
const isUrl = (protocols: string[]) => (value: string) =>
  URL.canParse(value) && protocols.includes(new URL(value).protocol);
const isPostgresUrl = isUrl(["postgres:", "postgresql:"]);

/** The percent-decoded password of a URL, or null when its encoding is malformed. */
function passwordOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

const required = { error: "is required" };
const text = z.string(required).min(1, "must not be empty");
const strong = (what: string) =>
  text
    .refine(
      (v) => Buffer.byteLength(v) >= SECRET_FLOOR_BYTES,
      `${what} must be at least ${SECRET_FLOOR_BYTES} bytes`,
    )
    .refine(notDefault, "is a known example value");
const databaseUrl = text
  .refine(isPostgresUrl, "must be a postgres:// URL")
  .refine((v) => !isPostgresUrl(v) || passwordOf(v) !== null, "has a malformed percent-encoded password")
  .refine((v) => !isPostgresUrl(v) || notDefault(passwordOf(v) ?? ""), "carries a known example password");

const roleVariable = (prefix: string, role: Role) => `${prefix}${role.toUpperCase()}`;

const schema = z.object({
  SHOUTORY_HMAC_PEPPER: strong("the pepper"),
  SHOUTORY_SESSION_SECRET: strong("the session secret"),
  SHOUTORY_SMTP_URL: text.refine(isUrl(["smtp:", "smtps:"]), "must be an smtp:// or smtps:// URL"),
});

/** The database roles each process role connects as; the owner and readonly URLs are never read by a server. */
const URL_ROLES: Readonly<Record<"api" | "worker" | "all", readonly Role[]>> = {
  api: ["app", "auth"],
  worker: ["worker"],
  all: ["app", "auth", "worker"],
};

/**
 * The names of the secret variables, kept here so the logger's registered values come from the one list. It covers
 * every database URL and password name, not only the ones this process needs: an operator may still set them.
 */
export const SECRET_VARIABLES: readonly string[] = [
  ...Object.keys(schema.shape),
  ...ROLES.map((r) => roleVariable("SHOUTORY_DATABASE_PASSWORD_", r)),
  ...ROLES.map((r) => roleVariable("SHOUTORY_DATABASE_URL_", r)),
];

const MAX_PORT = 65535;
const isOrigin = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const plain = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  return plain && ["http:", "https:"].includes(url.protocol);
};
/** `address/prefix`; a bare address is not a CIDR, so a proxy list never trusts a whole range by accident. */
const isCidr = (value: string) => {
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address ?? "");
  const limit = family === 4 ? 32 : 128;
  return rest.length === 0 && family > 0 && /^[0-9]{1,3}$/.test(prefix ?? "") && Number(prefix) <= limit;
};
/** `user@domain` or `Display Name <user@domain>`; the display name may not carry a quote, angle bracket or line break. */
const isSender = (value: string) => {
  const found = /^(?:[^<>"\r\n]*<([^<>\s]+)>|([^<>\s"]+))$/.exec(value.trim());
  return z.email().safeParse(found?.[1] ?? found?.[2]).success;
};
const sender = z.string().refine(isSender, "must be an address or Name <address>");
const cidrList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().refine(isCidr, "must be a comma-separated list of CIDR ranges")));

const RELEASE_CHANNELS = ["stable", "beta", "nightly"] as const;

// The non-secret HTTP settings (R41). The origin has no default: a default would let CSRF accept a wrong origin.
const httpSchema = z
  .object({
    SHOUTORY_ROLE: z.enum(["api", "worker", "all"]).default("all"),
    SHOUTORY_PUBLIC_ORIGIN: z
      .string()
      .refine(isOrigin, "must be an http or https origin with no path, query or userinfo")
      .optional(),
    SHOUTORY_PORT: z
      .string()
      .regex(/^[0-9]{1,5}$/, "must be a port from 1 to 65535")
      .default("3000")
      .transform(Number)
      .pipe(
        z.number().min(1, "must be a port from 1 to 65535").max(MAX_PORT, "must be a port from 1 to 65535"),
      ),
    SHOUTORY_TRUSTED_PROXIES: cidrList,
    // The one operator allowlist of the egress guard. Metadata and link-local ranges are never allowable.
    SHOUTORY_EGRESS_ALLOW_CIDRS: cidrList.refine(
      (list) => list.every((entry) => !isMetadataOrLinkLocal(entry.split("/")[0] ?? "")),
      "must not list a metadata or link-local range",
    ),
    // The built web app; unset means this process serves no web (a worker never does).
    SHOUTORY_WEB_ROOT: z
      .string()
      .refine((value) => isAbsolutePath(value), "must be an absolute path")
      .optional(),
    SHOUTORY_HOST: z
      .string()
      .refine((value) => isIP(value) > 0, "must be an IPv4 or IPv6 address")
      .optional(),
    // Transactional and marketing mail travel on separate senders (rule 100); there is no default sender address.
    SHOUTORY_MAIL_FROM: sender.optional(),
    SHOUTORY_MAIL_MARKETING_FROM: sender.optional(),
    SHOUTORY_MAIL_DKIM_SELECTOR: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/, "must be a DNS label")
      .optional(),
    // Build metadata the image sets per tag (what the admin screen shows); not a feature switch.
    SHOUTORY_RELEASE_CHANNEL: z.enum(RELEASE_CHANNELS).default("stable"),
  })
  .superRefine((value, ctx) => {
    if (value.SHOUTORY_ROLE !== "worker" && value.SHOUTORY_PUBLIC_ORIGIN === undefined) {
      ctx.addIssue({ code: "custom", path: ["SHOUTORY_PUBLIC_ORIGIN"], message: "is required" });
    }
    // A role that sends mail needs the sender; the api role only queues it.
    if (value.SHOUTORY_ROLE !== "api" && value.SHOUTORY_MAIL_FROM === undefined) {
      ctx.addIssue({ code: "custom", path: ["SHOUTORY_MAIL_FROM"], message: "is required" });
    }
  });

export type ServerRole = z.infer<typeof httpSchema>["SHOUTORY_ROLE"];

// Where objects are stored (R331). The filesystem driver's data directory is never created by the driver, so a relative
// path (which would follow the working directory) is refused at start-up. With driver s3 every S3 setting is required.
const isAbsolutePath = (value: string) => posix.isAbsolute(value) || win32.isAbsolute(value);
const driverSchema = z.object({ SHOUTORY_STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs") });
const fsSchema = z.object({
  SHOUTORY_DATA_DIR: z.string().refine(isAbsolutePath, "must be an absolute path").default("/data"),
});

// http or https only, no userinfo (a secret never rides in a URL), and no literal metadata or link-local host (the shared
// classifier of the egress guard, R332).
const isS3Endpoint = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const plain = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  return plain && !isMetadataOrLinkLocal(url.hostname);
};
const S3_ENDPOINT_RULE =
  "must be an http or https URL with no userinfo and no metadata or link-local address";
const s3Schema = z.object({
  SHOUTORY_S3_ENDPOINT: text.refine(isS3Endpoint, S3_ENDPOINT_RULE),
  // The address browsers reach the S3 server at, where it differs from the one the server uses; presigned URLs carry it.
  SHOUTORY_S3_PUBLIC_ENDPOINT: text.refine(isS3Endpoint, S3_ENDPOINT_RULE).optional(),
  SHOUTORY_S3_REGION: text,
  SHOUTORY_S3_BUCKET: text,
  SHOUTORY_S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SHOUTORY_S3_ACCESS_KEY_ID: text,
  SHOUTORY_S3_SECRET_ACCESS_KEY: text,
});

/** The S3 credentials; the logger and the command-line scrubber register their values like the other secrets. */
export const STORAGE_SECRET_VARIABLES: readonly string[] = [
  "SHOUTORY_S3_ACCESS_KEY_ID",
  "SHOUTORY_S3_SECRET_ACCESS_KEY",
];

export type StorageConfig =
  | { driver: "fs"; dataDir: string }
  | {
      driver: "s3";
      endpoint: string;
      /** Where presigned URLs point; the endpoint itself unless the operator set `SHOUTORY_S3_PUBLIC_ENDPOINT`. */
      publicEndpoint: string;
      region: string;
      bucket: string;
      forcePathStyle: boolean;
      accessKeyId: SealedSecret;
      secretAccessKey: SealedSecret;
    };

function parseWith<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw refusal(parsed.error);
  return parsed.data;
}

/** The storage settings alone: `shoutory storage check` needs no other setting. */
export function parseStorageEnv(env: Env): StorageConfig {
  const { SHOUTORY_STORAGE_DRIVER: driver } = parseWith(driverSchema, env);
  if (driver === "fs") return { driver, dataDir: parseWith(fsSchema, env).SHOUTORY_DATA_DIR };
  const s3 = parseWith(s3Schema, env);
  return {
    driver,
    endpoint: s3.SHOUTORY_S3_ENDPOINT,
    publicEndpoint: s3.SHOUTORY_S3_PUBLIC_ENDPOINT ?? s3.SHOUTORY_S3_ENDPOINT,
    region: s3.SHOUTORY_S3_REGION,
    bucket: s3.SHOUTORY_S3_BUCKET,
    forcePathStyle: s3.SHOUTORY_S3_FORCE_PATH_STYLE,
    accessKeyId: new SealedSecret(s3.SHOUTORY_S3_ACCESS_KEY_ID),
    secretAccessKey: new SealedSecret(s3.SHOUTORY_S3_SECRET_ACCESS_KEY),
  };
}

export interface Config {
  role: ServerRole;
  /** Set for every role that serves HTTP; only a worker may lack it. */
  publicOrigin: string | undefined;
  port: number;
  /** The address to listen on; unset means the Node default (all interfaces). */
  host: string | undefined;
  trustedProxies: readonly string[];
  /** The operator egress allowlist (CIDR texts); empty by default, and the cloud composition root passes none. */
  egressAllowCidrs: readonly string[];
  /** The folder of the built web app; unset means no web is served. */
  webRoot: string | undefined;
  keys: KeyProvider;
  hmacPepper: SealedSecret;
  sessionSecret: SealedSecret;
  smtpUrl: SealedSecret;
  /** The transactional sender; set for every role that sends mail (`worker`, `all`). */
  mailFrom: string | undefined;
  mailMarketingFrom: string | undefined;
  mailDkimSelector: string | undefined;
  /** The release channel of this build: `stable` unless the image says `beta` or `nightly`. */
  releaseChannel: (typeof RELEASE_CHANNELS)[number];
  storage: StorageConfig;
  /** Only the URLs of the roles this process role connects as (`URL_ROLES`); read one through `databaseUrlOf`. */
  databaseUrls: Readonly<Partial<Record<Role, SealedSecret>>>;
}

/** The connection URL of a database role; a role the process was not configured for is a programming error. */
export function databaseUrlOf(config: Config, role: keyof Config["databaseUrls"]): SealedSecret {
  const url = config.databaseUrls[role];
  if (url === undefined) throw new ConfigError(roleVariable("SHOUTORY_DATABASE_URL_", role), "is not set");
  return url;
}

/** The key ring alone, from the key variables: the operator commands need no other setting. */
export function parseKeyRing(env: Env): KeyProvider {
  try {
    const keys = new EnvKeyProvider(env);
    for (const [variable, value] of Object.entries(env)) {
      if (variable.startsWith("SHOUTORY_KEK_") && value && !notDefault(value)) {
        throw new ConfigError(variable, `${variable} is a known example value`);
      }
    }
    return keys;
  } catch (error) {
    if (error instanceof KeyError)
      throw new ConfigError(error.variable ?? "SHOUTORY_ACTIVE_KEY_ID", error.message);
    throw error;
  }
}

function refusal(error: z.ZodError): ConfigError {
  const issue = error.issues[0];
  const variable = String(issue?.path[0] ?? "environment");
  return new ConfigError(variable, `${variable} ${issue?.message ?? "is invalid"}`);
}

/**
 * The authentication library reads `BETTER_AUTH_*` and `AUTH_*` itself (its secret, base URL, trusted origins, and a
 * telemetry switch that overrides the option). Configuration is only ours, so such a variable refuses the start.
 */
function assertNoLibrarySwitches(env: Env): void {
  const found = Object.keys(env).find((name) => /^(BETTER_AUTH|AUTH)_/.test(name) && env[name] !== undefined);
  if (found)
    throw new ConfigError(
      found,
      `${found} is not accepted: authentication is configured through SHOUTORY_ variables only`,
    );
}

/**
 * Parses the process environment, or refuses to start. Secrets have no default: a missing, empty, weak,
 * all-zero or example value raises a `ConfigError` that names the variable and never prints the value.
 */
export function parseEnv(env: Env): Config {
  assertNoLibrarySwitches(env);
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw refusal(parsed.error);
  const http = httpSchema.safeParse(env);
  if (!http.success) throw refusal(http.error);
  const urlNames = URL_ROLES[http.data.SHOUTORY_ROLE].map((r) => roleVariable("SHOUTORY_DATABASE_URL_", r));
  const urls = z.object(Object.fromEntries(urlNames.map((name) => [name, databaseUrl]))).safeParse(env);
  if (!urls.success) throw refusal(urls.error);
  const value: Record<string, string> = { ...parsed.data, ...urls.data };
  const secret = (name: string) => new SealedSecret(value[name] as string);
  return {
    role: http.data.SHOUTORY_ROLE,
    publicOrigin: http.data.SHOUTORY_PUBLIC_ORIGIN && new URL(http.data.SHOUTORY_PUBLIC_ORIGIN).origin,
    port: http.data.SHOUTORY_PORT,
    host: http.data.SHOUTORY_HOST,
    trustedProxies: http.data.SHOUTORY_TRUSTED_PROXIES,
    egressAllowCidrs: http.data.SHOUTORY_EGRESS_ALLOW_CIDRS,
    webRoot: http.data.SHOUTORY_WEB_ROOT,
    keys: parseKeyRing(env),
    hmacPepper: secret("SHOUTORY_HMAC_PEPPER"),
    sessionSecret: secret("SHOUTORY_SESSION_SECRET"),
    smtpUrl: secret("SHOUTORY_SMTP_URL"),
    mailFrom: http.data.SHOUTORY_MAIL_FROM,
    mailMarketingFrom: http.data.SHOUTORY_MAIL_MARKETING_FROM,
    mailDkimSelector: http.data.SHOUTORY_MAIL_DKIM_SELECTOR,
    releaseChannel: http.data.SHOUTORY_RELEASE_CHANNEL,
    storage: parseStorageEnv(env),
    databaseUrls: Object.fromEntries(
      URL_ROLES[http.data.SHOUTORY_ROLE].map((r) => [r, secret(roleVariable("SHOUTORY_DATABASE_URL_", r))]),
    ),
  };
}

/** The process runs in UTC; `main.ts` calls this before anything reads a clock. */
export function assertUtc(env: Env): void {
  if (env.TZ !== "UTC") throw new ConfigError("TZ", "TZ must be UTC");
}
