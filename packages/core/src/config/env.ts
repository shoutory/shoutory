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

export interface Config {
  keys: KeyProvider;
  hmacPepper: SealedSecret;
  sessionSecret: SealedSecret;
  smtpUrl: SealedSecret;
  databaseUrls: Readonly<Record<Role, SealedSecret>>;
}

function parseKeys(env: Env): KeyProvider {
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

/**
 * Parses the process environment, or refuses to start. Secrets have no default: a missing, empty, weak,
 * all-zero or example value raises a `ConfigError` that names the variable and never prints the value.
 */
export function parseEnv(env: Env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const variable = String(issue?.path[0] ?? "environment");
    throw new ConfigError(variable, `${variable} ${issue?.message ?? "is invalid"}`);
  }
  const value = parsed.data as Record<string, string>;
  const secret = (name: string) => new SealedSecret(value[name] as string);
  return {
    keys: parseKeys(env),
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
