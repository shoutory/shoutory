/** One request and its answer as captured from a provider, before and after the secrets are taken out. */
export interface RecordedExchange {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | undefined;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | undefined;
  };
}

// The one closed list of where a secret sits. A provider that puts one somewhere else is added here, with a test row.
const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie", "dpop"];
const SECRET_JSON_KEYS = [
  "code_verifier",
  "d", // the private member of a JWK
];
// A query string, fragment or form body also carries the one-time OAuth values, which a JSON answer uses for plain codes.
const SECRET_FORM_FIELDS = [...SECRET_JSON_KEYS, "code", "state"];
// Besides the lists, any header, field or JSON key named like a credential is a secret (case-insensitive).
const SECRET_NAME = /token|secret|key|signature|password|assertion/i;
const isSecretName = (list: readonly string[], name: string) =>
  list.includes(lower(name)) || SECRET_NAME.test(name);
// A bot token follows `bot<digits>:` and a webhook token follows `webhooks/<digits>/` in the path.
const TOKEN_PATH_PATTERNS = [/\/bot\d+:([^/?#]+)/g, /\/webhooks\/\d+\/([^/?#]+)/g];

const REDACTED = "[redacted]";
// Anything shorter is not a credential a provider issues, and sweeping it out would damage every other string.
const MIN_SWEEP_LENGTH = 4;

const lower = (name: string) => name.toLowerCase();

// The credential after the scheme; a Basic one also yields its password, which is what an answer would echo.
function credential(value: string): string[] {
  const space = value.indexOf(" ");
  const rest = value.slice(space + 1);
  if (lower(value.slice(0, Math.max(space, 0))) !== "basic") return [rest];
  const decodedPair = Buffer.from(rest, "base64").toString("utf8");
  const colon = decodedPair.indexOf(":");
  return colon < 0 ? [rest] : [rest, decodedPair.slice(colon + 1)];
}

function headerSecrets(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    const key = lower(name);
    if (!isSecretName(SECRET_HEADERS, key)) return [];
    if (key === "authorization" || key === "proxy-authorization") return credential(value);
    if (key === "cookie" || key === "set-cookie") {
      // A cookie header lists name=value pairs; a set-cookie header has one pair, then attributes.
      const pairs = value.split(";").slice(0, key === "set-cookie" ? 1 : undefined);
      return pairs.map((pair) => pair.slice(pair.indexOf("=") + 1).trim());
    }
    return [value];
  });
}

function jsonSecrets(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonSecrets);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) =>
    isSecretName(SECRET_JSON_KEYS, key) && typeof member === "string" ? [member] : jsonSecrets(member),
  );
}

function fieldSecrets(fields: URLSearchParams): string[] {
  return [...fields].filter(([name]) => isSecretName(SECRET_FORM_FIELDS, name)).map(([, value]) => value);
}

function decoded(segment: string): string[] {
  try {
    return [segment, decodeURIComponent(segment)];
  } catch (error) {
    if (error instanceof URIError) return [segment];
    throw error;
  }
}

function urlSecrets(url: string): string[] {
  const paths = TOKEN_PATH_PATTERNS.flatMap((pattern) =>
    [...url.matchAll(pattern)].flatMap((match) => decoded(match[1] ?? "")),
  );
  if (!URL.canParse(url)) return paths;
  const { searchParams, hash } = new URL(url);
  return [...paths, ...fieldSecrets(searchParams), ...fieldSecrets(new URLSearchParams(hash.slice(1)))];
}

// A body is read as JSON when it parses and as form fields otherwise, whatever its content type says.
function bodySecrets(body: string | undefined): string[] {
  if (body === undefined) return [];
  try {
    return jsonSecrets(JSON.parse(body));
  } catch (error) {
    if (error instanceof SyntaxError) return fieldSecrets(new URLSearchParams(body));
    throw error;
  }
}

// The base64 characters that depend on the secret alone when it follows `offset` other bytes inside a longer string.
function alignment(bytes: Buffer, offset: number): string {
  const whole = Buffer.concat([Buffer.alloc(offset), bytes]);
  return whole.toString("base64").slice(Math.ceil((8 * offset) / 6), Math.floor((8 * whole.length) / 6));
}

// Every form a secret may be echoed in (AGENTS 4.2): raw, percent-encoded in both cases, form-encoded, hex, base64 padded,
// unpadded and URL-safe, JSON-escaped, and base64 inside a longer string at each of its three alignments.
function forms(secret: string): string[] {
  const bytes = Buffer.from(secret);
  const percent = encodeURIComponent(secret);
  return [
    secret,
    percent,
    percent.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    new URLSearchParams([["k", secret]]).toString().slice(2),
    bytes.toString("hex"),
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    JSON.stringify(secret).slice(1, -1),
    ...[0, 1, 2].map((offset) => alignment(bytes, offset)),
  ];
}

function sweeper(secrets: readonly string[]): (text: string) => string {
  const needles = [...new Set(secrets.filter((s) => s.length >= MIN_SWEEP_LENGTH).flatMap(forms))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => needles.reduce((rest, needle) => rest.split(needle).join(REDACTED), text);
}

/**
 * Takes every secret out of an exchange. Secrets are found by place (the closed lists above) and then swept out of every
 * string of the exchange in every form, so an answer that echoes one is clean too. Everything else is kept.
 */
export function scrubExchange(exchange: RecordedExchange): RecordedExchange {
  const { request, response } = exchange;
  const sweep = sweeper([
    ...headerSecrets(request.headers),
    ...headerSecrets(response.headers),
    ...urlSecrets(request.url),
    ...bodySecrets(request.body),
    ...bodySecrets(response.body),
  ]);
  const headers = (all: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(all).map(([name, value]) => [name, sweep(value)]));
  return {
    request: {
      method: request.method,
      url: sweep(request.url),
      headers: headers(request.headers),
      ...(request.body === undefined ? {} : { body: sweep(request.body) }),
    },
    response: {
      status: response.status,
      headers: headers(response.headers),
      ...(response.body === undefined ? {} : { body: sweep(response.body) }),
    },
  };
}
