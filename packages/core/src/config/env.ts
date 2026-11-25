import { isIP } from "node:net";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { SealedSecret } from "../crypto/envelope.js";
import { EnvKeyProvider, KeyError, type KeyProvider } from "../crypto/keys.js";
import { isMetadataOrLinkLocal } from "../net/address.js";

export type Env = Readonly<Record<string, string | undefined>>;

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

// Example values the README and the compose notes show; each is format-valid, so only this list can refuse it.
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

const URL_ROLES: Readonly<Record<"api" | "worker" | "all", readonly Role[]>> = {
  api: ["app", "auth"],
  worker: ["worker"],
  all: ["app", "auth", "worker"],
};

// Covers every database URL and password name, not only the ones this process needs: an operator may still set them.
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
const isCidr = (value: string) => {
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address ?? "");
  const limit = family === 4 ? 32 : 128;
  return rest.length === 0 && family > 0 && /^[0-9]{1,3}$/.test(prefix ?? "") && Number(prefix) <= limit;
};
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

// The origin has no default: a default would let CSRF accept a wrong origin.
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
    SHOUTORY_EGRESS_ALLOW_CIDRS: cidrList.refine(
      (list) => list.every((entry) => !isMetadataOrLinkLocal(entry.split("/")[0] ?? "")),
      "must not list a metadata or link-local range",
    ),
    SHOUTORY_WEB_ROOT: z
      .string()
      .refine((value) => isAbsolutePath(value), "must be an absolute path")
      .optional(),
    SHOUTORY_HOST: z
      .string()
      .refine((value) => isIP(value) > 0, "must be an IPv4 or IPv6 address")
      .optional(),
    // Transactional and marketing mail travel on separate senders; there is no default sender address.
    SHOUTORY_MAIL_FROM: sender.optional(),
    SHOUTORY_MAIL_MARKETING_FROM: sender.optional(),
    SHOUTORY_MAIL_DKIM_SELECTOR: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/, "must be a DNS label")
      .optional(),
    // Build metadata the image sets per tag, not a feature switch.
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

// A relative data directory would follow the working directory, so it is refused at start-up.
const isAbsolutePath = (value: string) => posix.isAbsolute(value) || win32.isAbsolute(value);
const driverSchema = z.object({ SHOUTORY_STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs") });
const fsSchema = z.object({
  SHOUTORY_DATA_DIR: z.string().refine(isAbsolutePath, "must be an absolute path").default("/data"),
});

// No userinfo: a secret never rides in a URL.
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

export const STORAGE_SECRET_VARIABLES: readonly string[] = [
  "SHOUTORY_S3_ACCESS_KEY_ID",
  "SHOUTORY_S3_SECRET_ACCESS_KEY",
];

export type StorageConfig =
  | { driver: "fs"; dataDir: string }
  | {
      driver: "s3";
      endpoint: string;
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

// The scanner is the operator's own clamd, so its host is a setting and never a workspace field.
// A host made only of digits is refused: a connect reads it as one number (2852039166 is 169.254.169.254).
const isScannerHost = (value: string) =>
  /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) &&
  !/^\d+$/.test(value) &&
  !isMetadataOrLinkLocal(value);
const scanSchema = z.object({
  SHOUTORY_MEDIA_SCAN: z.enum(["off", "warn"]).default("off"),
  SHOUTORY_CLAMAV_HOST: text
    .refine(isScannerHost, "must be a host name or address with no userinfo or path")
    .optional(),
  SHOUTORY_CLAMAV_PORT: z
    .string()
    .regex(/^\d{1,5}$/, "must be a port number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .default(3310),
});

export type MediaScanConfig = { mode: "off" } | { mode: "warn"; host: string; port: number };

export function parseMediaScanEnv(env: Env): MediaScanConfig {
  const scan = parseWith(scanSchema, env);
  if (scan.SHOUTORY_MEDIA_SCAN === "off") return { mode: "off" };
  if (scan.SHOUTORY_CLAMAV_HOST === undefined)
    throw new ConfigError(
      "SHOUTORY_CLAMAV_HOST",
      "SHOUTORY_CLAMAV_HOST is required with SHOUTORY_MEDIA_SCAN=warn",
    );
  return { mode: "warn", host: scan.SHOUTORY_CLAMAV_HOST, port: scan.SHOUTORY_CLAMAV_PORT };
}

const ffprobeSchema = z.object({
  SHOUTORY_FFPROBE_PATH: z
    .string()
    .refine((value) => value === "" || isAbsolutePath(value), "must be an absolute path")
    .optional(),
});

// An empty value is unset, so an operator can turn video probing off over the image's own setting.
export function parseFfprobeEnv(env: Env): string | undefined {
  return parseWith(ffprobeSchema, env).SHOUTORY_FFPROBE_PATH || undefined;
}

// A disk folder for the copies the media worker reads, whatever the storage driver: the system temp folder may be
// held in memory.
const scratchSchema = z.object({
  SHOUTORY_SCRATCH_DIR: z
    .string()
    .refine(isAbsolutePath, "must be an absolute path")
    .default("/data/scratch"),
});

// The most bytes one workspace may store, so one workspace cannot fill the operator's disk; unset is no cap.
const workspaceCapSchema = z.object({
  SHOUTORY_MEDIA_WORKSPACE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});

export interface Config {
  role: ServerRole;
  publicOrigin: string | undefined;
  port: number;
  host: string | undefined;
  trustedProxies: readonly string[];
  egressAllowCidrs: readonly string[];
  webRoot: string | undefined;
  keys: KeyProvider;
  hmacPepper: SealedSecret;
  sessionSecret: SealedSecret;
  smtpUrl: SealedSecret;
  mailFrom: string | undefined;
  mailMarketingFrom: string | undefined;
  mailDkimSelector: string | undefined;
  releaseChannel: (typeof RELEASE_CHANNELS)[number];
  storage: StorageConfig;
  mediaScan: MediaScanConfig;
  ffprobePath: string | undefined;
  scratchDir: string;
  mediaWorkspaceMaxBytes: number | undefined;
  databaseUrls: Readonly<Partial<Record<Role, SealedSecret>>>;
}

export function databaseUrlOf(config: Config, role: keyof Config["databaseUrls"]): SealedSecret {
  const url = config.databaseUrls[role];
  if (url === undefined) throw new ConfigError(roleVariable("SHOUTORY_DATABASE_URL_", role), "is not set");
  return url;
}

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

// The authentication library reads these variables itself (secret, base URL, trusted origins, telemetry) and would
// override our configuration.
function assertNoLibrarySwitches(env: Env): void {
  const found = Object.keys(env).find((name) => /^(BETTER_AUTH|AUTH)_/.test(name) && env[name] !== undefined);
  if (found)
    throw new ConfigError(
      found,
      `${found} is not accepted: authentication is configured through SHOUTORY_ variables only`,
    );
}

// One value in two places means one leak exposes both. The later variable in this order is named, never the value.
function assertDistinctSecrets(env: Env): void {
  const keks = Object.keys(env)
    .filter((name) => name.startsWith("SHOUTORY_KEK_"))
    .sort();
  const seen = new Map<string, string>();
  for (const name of ["SHOUTORY_HMAC_PEPPER", "SHOUTORY_SESSION_SECRET", ...keks]) {
    const value = env[name];
    if (!value) continue;
    const first = seen.get(value);
    if (first) throw new ConfigError(name, `${name} repeats the value of ${first}; every secret must differ`);
    seen.set(value, name);
  }
}

export function parseEnv(env: Env): Config {
  assertNoLibrarySwitches(env);
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw refusal(parsed.error);
  const http = httpSchema.safeParse(env);
  if (!http.success) throw refusal(http.error);
  const urlNames = URL_ROLES[http.data.SHOUTORY_ROLE].map((r) => roleVariable("SHOUTORY_DATABASE_URL_", r));
  const urls = z.object(Object.fromEntries(urlNames.map((name) => [name, databaseUrl]))).safeParse(env);
  if (!urls.success) throw refusal(urls.error);
  assertDistinctSecrets(env);
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
    mediaScan: parseMediaScanEnv(env),
    ffprobePath: parseFfprobeEnv(env),
    scratchDir: parseWith(scratchSchema, env).SHOUTORY_SCRATCH_DIR,
    mediaWorkspaceMaxBytes: parseWith(workspaceCapSchema, env).SHOUTORY_MEDIA_WORKSPACE_MAX_BYTES,
    databaseUrls: Object.fromEntries(
      URL_ROLES[http.data.SHOUTORY_ROLE].map((r) => [r, secret(roleVariable("SHOUTORY_DATABASE_URL_", r))]),
    ),
  };
}

export function assertUtc(env: Env): void {
  if (env.TZ !== "UTC") throw new ConfigError("TZ", "TZ must be UTC");
}
