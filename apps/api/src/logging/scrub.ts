/** The credential keys, compared case-insensitively at any depth. */
const CENSORED_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "apikey",
]);
const CENSOR = "[Redacted]";
const TRUNCATED = "[truncated]";
const CIRCULAR = "[Circular]";
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
// A shorter registered value would mask ordinary words on every line.
const MIN_SECRET_LENGTH = 8;

export type Scrubber = (value: unknown) => unknown;

/** The five spellings of a value that the canary rule (AGENTS 4.2) checks: raw, percent, hex, base64, JSON-escaped. */
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

function plainError(error: Error): Record<string, unknown> {
  return { type: error.name, message: error.message, stack: error.stack, cause: error.cause };
}

/**
 * Builds the one scrubber every log call passes through: credential keys are censored at any depth, every registered
 * value is replaced in every string in its five spellings, an Error becomes type, message, stack and cause, and
 * depth stops at 8. It throws on a value it cannot read (a hostile getter); the logger turns that into a
 * fixed marker line, never the raw value.
 */
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

// At most MAX_ENTRIES items are kept; the rest become one marker.
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
