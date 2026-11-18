import { isIP } from "node:net";
import { z } from "zod";
import { SealedSecret } from "../crypto/envelope.js";
import { EnvKeyProvider, KeyError, type KeyProvider } from "../crypto/keys.js";

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

const rolePairs = (prefix: string, field: z.ZodType) =>
  Object.fromEntries(ROLES.map((r) => [`${prefix}${r.toUpperCase()}`, field]));

const schema = z.object({
  SHOUTORY_HMAC_PEPPER: strong("the pepper"),
  SHOUTORY_SESSION_SECRET: strong("the session secret"),
  SHOUTORY_SMTP_URL: text.refine(isUrl(["smtp:", "smtps:"]), "must be an smtp:// or smtps:// URL"),
  ...rolePairs("SHOUTORY_DATABASE_PASSWORD_", text.refine(notDefault, "is a known example value")),
  ...rolePairs("SHOUTORY_DATABASE_URL_", databaseUrl),
});

/** The names of the secret variables, kept here so the logger's registered values come from the one list. */
export const SECRET_VARIABLES: readonly string[] = Object.keys(schema.shape);

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
    SHOUTORY_HOST: z
      .string()
      .refine((value) => isIP(value) > 0, "must be an IPv4 or IPv6 address")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.SHOUTORY_ROLE !== "worker" && value.SHOUTORY_PUBLIC_ORIGIN === undefined) {
      ctx.addIssue({ code: "custom", path: ["SHOUTORY_PUBLIC_ORIGIN"], message: "is required" });
    }
  });

export type ServerRole = z.infer<typeof httpSchema>["SHOUTORY_ROLE"];

export interface Config {
  role: ServerRole;
  /** Set for every role that serves HTTP; only a worker may lack it. */
  publicOrigin: string | undefined;
  port: number;
  /** The address to listen on; unset means the Node default (all interfaces). */
  host: string | undefined;
  trustedProxies: readonly string[];
  keys: KeyProvider;
  hmacPepper: SealedSecret;
  sessionSecret: SealedSecret;
  smtpUrl: SealedSecret;
  databaseUrls: Readonly<Record<Role, SealedSecret>>;
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
  const value = parsed.data as Record<string, string>;
  const secret = (name: string) => new SealedSecret(value[name] as string);
  return {
    role: http.data.SHOUTORY_ROLE,
    publicOrigin: http.data.SHOUTORY_PUBLIC_ORIGIN && new URL(http.data.SHOUTORY_PUBLIC_ORIGIN).origin,
    port: http.data.SHOUTORY_PORT,
    host: http.data.SHOUTORY_HOST,
    trustedProxies: http.data.SHOUTORY_TRUSTED_PROXIES,
    keys: parseKeyRing(env),
    hmacPepper: secret("SHOUTORY_HMAC_PEPPER"),
    sessionSecret: secret("SHOUTORY_SESSION_SECRET"),
    smtpUrl: secret("SHOUTORY_SMTP_URL"),
    databaseUrls: Object.fromEntries(
      ROLES.map((r) => [r, secret(`SHOUTORY_DATABASE_URL_${r.toUpperCase()}`)]),
    ) as Record<Role, SealedSecret>,
  };
}

/** The process runs in UTC; `main.ts` calls this before anything reads a clock. */
export function assertUtc(env: Env): void {
  if (env.TZ !== "UTC") throw new ConfigError("TZ", "TZ must be UTC");
}
