import { SECRET_VARIABLES, STORAGE_SECRET_VARIABLES } from "@shoutory/core/config";

const KEK_PREFIX = "SHOUTORY_KEK_";
const OTLP_HEADER_VARIABLES = ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"];
const CENSORED_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "apikey",
  "newpassword",
  "currentpassword",
  // The user's own TOTP URI and backup codes appear once, in the enrolment answers, and never in a log.
  "totpuri",
  "backupcodes",
]);
const CENSOR = "[Redacted]";
const TRUNCATED = "[truncated]";
const CIRCULAR = "[Circular]";
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
// A shorter registered value would mask ordinary words on every line.
const MIN_SECRET_LENGTH = 8;

export type Scrubber = (value: unknown) => unknown;

function decodedPassword(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  try {
    return decodeURIComponent(new URL(value).password);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

// `name=value,name=value`, values percent-encoded (OpenTelemetry exporter configuration). A value such as
// `Bearer <token>` also registers its last word, since the token shows up alone in a request log.
function headerValues(list: string): string[] {
  return list.split(",").flatMap((pair) => {
    const value = pair.slice(pair.indexOf("=") + 1).trim();
    const decoded = safeDecode(value);
    return [value, decoded, decoded.split(/\s+/).at(-1) ?? decoded];
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return value;
    throw error;
  }
}

export function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const headers = OTLP_HEADER_VARIABLES.flatMap((name) => headerValues(env[name] ?? ""));
  const names = [
    ...SECRET_VARIABLES,
    ...STORAGE_SECRET_VARIABLES,
    ...Object.keys(env).filter((name) => name.startsWith(KEK_PREFIX)),
  ];
  const values = names.flatMap((name) => {
    const value = env[name];
    return value ? [value, decodedPassword(value)] : [];
  });
  const usable = [...values, ...headers].filter(
    (v): v is string => v !== undefined && v.length >= MIN_SECRET_LENGTH,
  );
  return [...new Set(usable)];
}

function spellings(secret: string): string[] {
  const buffer = Buffer.from(secret);
  return [
    secret,
    encodeURIComponent(secret),
    buffer.toString("hex"),
    buffer.toString("base64"),
    JSON.stringify(secret).slice(1, -1),
  ];
}

function registeredForms(secrets: readonly string[]): string[] {
  const forms = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH).flatMap(spellings);
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

function maskString(text: string, forms: readonly string[]): string {
  return forms.reduce((out, form) => out.replaceAll(form, CENSOR), text);
}

// A query builder's error (Drizzle's) puts the SQL and every parameter in its message and stack header; only its
// type and the driver error in `cause` are kept.
const echoesQuery = (error: Error): boolean =>
  Object.hasOwn(error, "query") && Object.hasOwn(error, "params");

function plainError(error: Error): Record<string, unknown> {
  if (echoesQuery(error)) {
    const type = error.name === "Error" ? error.constructor.name : error.name;
    return { type, cause: error.cause };
  }
  return { type: error.name, message: error.message, stack: error.stack, cause: error.cause };
}

// It throws on a value it cannot read (a hostile getter); the logger turns that into a fixed marker line, never the
// raw value.
export function createScrubber(secrets: readonly string[]): Scrubber {
  const forms = registeredForms(secrets);
  const walk = (value: unknown, depth: number, ancestors: object[]): unknown => {
    if (typeof value === "string") return maskString(value, forms);
    if (value === null || typeof value !== "object") return scalar(value);
    if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
    if (depth > MAX_DEPTH) return TRUNCATED;
    if (ancestors.includes(value)) return CIRCULAR;
    const next = [...ancestors, value];
    const source = unwrap(value);
    if (source !== value) return walk(source, depth + 1, next);
    const child = (item: unknown) => walk(item, depth + 1, next);
    if (Array.isArray(value)) return capped(value, child);
    const entry = ([key, item]: [string, unknown]): [string, unknown] => [
      maskString(key, forms),
      CENSORED_KEYS.has(key.toLowerCase()) ? CENSOR : child(item),
    ];
    return Object.fromEntries(capped(Object.entries(value), entry, (n) => ["[more]", more(n)]));
  };
  return (value) => walk(value, 0, []);
}

const more = (n: number) => `[${n} more]`;

function capped<T, R = unknown>(
  items: T[],
  map: (item: T) => R,
  marker: (n: number) => R = (n) => more(n) as R,
): R[] {
  const kept = items.slice(0, MAX_ENTRIES).map(map);
  return items.length > MAX_ENTRIES ? [...kept, marker(items.length - MAX_ENTRIES)] : kept;
}

const scalar = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : typeof value === "function" ? undefined : value;

// A value that serializes itself (SealedSecret, Date) or is an Error becomes what it chooses to show.
function unwrap(value: object): unknown {
  if ("toJSON" in value && typeof value.toJSON === "function") return value.toJSON();
  return value instanceof Error ? plainError(value) : value;
}
