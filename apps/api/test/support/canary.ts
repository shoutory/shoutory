// The spellings a secret can take in a log line, a body or a dump (AGENTS 4.2): raw, percent-encoded, hex, base64,
// base64url and JSON-escaped.
const FORMS: [string, (secret: string) => string][] = [
  ["raw", (s) => s],
  ["percent-encoded", (s) => encodeURIComponent(s)],
  ["hex", (s) => Buffer.from(s).toString("hex")],
  ["base64", (s) => Buffer.from(s).toString("base64")],
  ["base64url", (s) => Buffer.from(s).toString("base64url")],
  ["JSON-escaped", (s) => JSON.stringify(s).slice(1, -1)],
];

/** The spellings of the secrets that the haystack holds; empty when none leaked. */
export const leaks = (haystack: string, secrets: string[]): string[] =>
  secrets.flatMap((secret) =>
    FORMS.filter(([, form]) => haystack.includes(form(secret))).map(
      ([name]) => `${name} ${secret.slice(0, 6)}`,
    ),
  );
