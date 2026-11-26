import { describe, expect, it } from "vitest";
import { type RecordedExchange, scrubExchange } from "./scrubber.js";

// Joined at run time so no secret-shaped literal sits in the source. The quote, backslash, plus, colon, space and
// apostrophe make each encoding below differ from the raw value.
const canary = (kind: string) => `${["can", "ary"].join('"')}\\${kind}+a:b c'd`;

// `middle` is the part of the base64 that depends on the secret alone, from the first full character it covers to the last it fills.
const embedded = (secret: string, offset: number) =>
  Buffer.concat([Buffer.alloc(offset, "x"), Buffer.from(secret), Buffer.from("tail-1")]).toString("base64");
const middle = (secret: string, offset: number) => {
  const whole = Buffer.concat([Buffer.alloc(offset, "x"), Buffer.from(secret)]);
  return whole.toString("base64").slice(Math.ceil((8 * offset) / 6), Math.floor((8 * whole.length) / 6));
};

interface Form {
  readonly name: string;
  readonly echo: (secret: string) => string;
  readonly needle: (secret: string) => string;
}
const plain = (name: string, encode: (secret: string) => string): Form => ({
  name,
  echo: encode,
  needle: encode,
});
const FORMS: Form[] = [
  plain("raw", (s) => s),
  plain("percent-encoded", (s) => encodeURIComponent(s)),
  plain("form-encoded", (s) => new URLSearchParams([["k", s]]).toString().slice(2)),
  plain("lowercase percent-hex", (s) =>
    encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
  ),
  plain("hex", (s) => Buffer.from(s).toString("hex")),
  plain("base64", (s) => Buffer.from(s).toString("base64")),
  plain("unpadded base64", (s) => Buffer.from(s).toString("base64").replace(/=+$/, "")),
  plain("base64url", (s) => Buffer.from(s).toString("base64url")),
  plain("JSON-escaped", (s) => JSON.stringify(s).slice(1, -1)),
  ...[0, 1, 2].map(
    (offset): Form => ({
      name: `base64 inside a longer string at offset ${offset}`,
      echo: (s) => embedded(s, offset),
      needle: (s) => middle(s, offset),
    }),
  ),
];

const HOST = "https://api.fixture.example";
const PLANTED = "planted-visible-1";

interface Placed extends Pick<RecordedExchange["request"], "url" | "headers" | "body"> {
  readonly response?: { readonly headers?: Record<string, string>; readonly body?: string };
}

const JSON_HEADERS = { "content-type": "application/json" };

const tokenAnswer = (member: string) => (s: string) => ({
  url: `${HOST}/token`,
  headers: {},
  response: { headers: JSON_HEADERS, body: JSON.stringify({ token_type: "bearer", [member]: s }) },
});

const JSON_MEMBERS = ["accessJwt", "refreshJwt", "credential", "bearer", "session", "sessionId"];

const KINDS: [string, (secret: string) => Placed][] = [
  ...JSON_MEMBERS.map((member): [string, (secret: string) => Placed] => [
    `${member} member in a json answer`,
    (s) => ({
      url: `${HOST}/session`,
      headers: {},
      response: { headers: JSON_HEADERS, body: JSON.stringify({ did: "did-1", [member]: s }) },
    }),
  ]),
  [
    "set-cookie response header",
    (s) => ({
      url: `${HOST}/login`,
      headers: {},
      response: { headers: { "set-cookie": `session=${s}; HttpOnly` } },
    }),
  ],
  ["access_token in a token answer", tokenAnswer("access_token")],
  ["refresh_token in a token answer", tokenAnswer("refresh_token")],
  ["id_token in a token answer", tokenAnswer("id_token")],
  [
    "client_secret in a form body",
    (s) => ({
      url: `${HOST}/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `client_id=app-1&client_secret=${encodeURIComponent(s)}`,
    }),
  ],
  [
    "password in a json body",
    (s) => ({
      url: `${HOST}/session`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ identifier: "handle-1", password: s }),
    }),
  ],
  ["x-api-key header", (s) => ({ url: `${HOST}/posts`, headers: { "x-api-key": s } })],
  ["authorization header", (s) => ({ url: `${HOST}/posts`, headers: { authorization: `Bearer ${s}` } })],
  ["cookie header", (s) => ({ url: `${HOST}/posts`, headers: { cookie: `session=${s}` } })],
  ["bot token path segment", (s) => ({ url: `${HOST}/bot123:${s}/sendMessage`, headers: {} })],
  ["webhook token path", (s) => ({ url: `${HOST}/api/webhooks/987/${s}`, headers: {} })],
  ["oauth code in a query", (s) => ({ url: `${HOST}/cb?code=${encodeURIComponent(s)}&x=1`, headers: {} })],
  ["oauth state in a query", (s) => ({ url: `${HOST}/cb?state=${encodeURIComponent(s)}&x=1`, headers: {} })],
  [
    "oauth code in a form body",
    (s) => ({
      url: `${HOST}/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${encodeURIComponent(s)}`,
    }),
  ],
  [
    "oauth state in a form body",
    (s) => ({
      url: `${HOST}/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `state=${encodeURIComponent(s)}&x=1`,
    }),
  ],
  ["dpop proof header", (s) => ({ url: `${HOST}/posts`, headers: { dpop: s } })],
  [
    "oauth code in a redirect location",
    (s) => ({
      url: `${HOST}/authorize?client_id=app-1`,
      headers: {},
      response: { headers: { location: `https://app.example/cb?code=${encodeURIComponent(s)}&x=1` } },
    }),
  ],
  [
    "access token in a redirect location fragment",
    (s) => ({
      url: `${HOST}/authorize?client_id=app-1`,
      headers: {},
      response: { headers: { location: `https://app.example/cb#access_token=${encodeURIComponent(s)}` } },
    }),
  ],
  [
    "oauth state in a referer",
    (s) => ({
      url: `${HOST}/posts`,
      headers: { referer: `https://app.example/cb?state=${encodeURIComponent(s)}` },
    }),
  ],
  [
    "access token in a url fragment",
    (s) => ({ url: `${HOST}/cb#access_token=${encodeURIComponent(s)}&token_type=bearer`, headers: {} }),
  ],
  [
    "form body with no content type",
    (s) => ({
      url: `${HOST}/token`,
      headers: {},
      body: `client_id=app-1&client_secret=${encodeURIComponent(s)}`,
    }),
  ],
  [
    "basic credential",
    (s) => ({
      url: `${HOST}/posts`,
      headers: { authorization: `Basic ${Buffer.from(`app-1:${s}`).toString("base64")}` },
    }),
  ],
  ["upper-case header name", (s) => ({ url: `${HOST}/posts`, headers: { Authorization: `Bearer ${s}` } })],
  [
    "repeated query parameter",
    (s) => ({ url: `${HOST}/cb?code=one&code=${encodeURIComponent(s)}`, headers: {} }),
  ],
  [
    "nested json member",
    (s) => ({
      url: `${HOST}/session`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ data: { auth: [{ access_token: s }] } }),
    }),
  ],
  ["second cookie", (s) => ({ url: `${HOST}/posts`, headers: { cookie: `a=1; session=${s}` } })],
  ["header whose name contains token", (s) => ({ url: `${HOST}/posts`, headers: { "x-session-token": s } })],
  [
    "json key whose name contains key",
    (s) => ({ url: `${HOST}/keys`, headers: JSON_HEADERS, body: JSON.stringify({ private_key: s }) }),
  ],
  [
    "form field whose name contains signature",
    (s) => ({
      url: `${HOST}/hooks`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `webhook_signature=${encodeURIComponent(s)}&x=1`,
    }),
  ],
  [
    "jwk private member",
    (s) => ({
      url: `${HOST}/keys`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kty: "EC", crv: "P-256", x: "public-x", y: "public-y", d: s }),
    }),
  ],
];

function exchangeWith(kind: string, build: (typeof KINDS)[number][1], form: Form) {
  const secret = canary(kind);
  const { body, response, ...rest } = build(secret);
  const echo = `echo ${form.echo(secret)} ${PLANTED}`;
  const exchange: RecordedExchange = {
    request: { method: "POST", ...rest, ...(body === undefined ? {} : { body }) },
    response: {
      status: 200,
      // The echo also rides in a header, so it reaches the sweep when the answer body is a token answer.
      headers: { "content-type": "text/plain", "x-echo": echo, ...response?.headers },
      body: response?.body ?? echo,
    },
  };
  return { secret, exchange };
}

function everyString(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(everyString);
}

describe("recorder", () => {
  const rows = KINDS.flatMap(([kind, build]) =>
    FORMS.map((form): [string, string, typeof build, Form] => [kind, form.name, build, form]),
  );

  it.each(rows)("never keeps a secret: %s echoed %s", (kind, _formName, build, form) => {
    const { secret, exchange } = exchangeWith(kind, build, form);
    const text = everyString(scrubExchange(exchange)).join("\n");
    for (const seen of FORMS) {
      expect(text, `${kind} survived as ${seen.name}`).not.toContain(seen.needle(secret));
    }
    expect(text).toContain(PLANTED);
  });

  it("does not treat a member that only starts with a secret word as a secret", () => {
    const exchange: RecordedExchange = {
      request: { method: "GET", url: `${HOST}/stats`, headers: {} },
      response: {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionCount: PLANTED, bearerOnly: PLANTED }),
      },
    };
    expect(scrubExchange(exchange)).toEqual(exchange);
  });

  it("leaves an exchange without secrets unchanged", () => {
    const exchange: RecordedExchange = {
      request: {
        method: "POST",
        url: `${HOST}/posts`,
        headers: { accept: "application/json" },
        body: PLANTED,
      },
      response: { status: 201, headers: { "content-type": "application/json" }, body: `{"id":"${PLANTED}"}` },
    };
    expect(scrubExchange(exchange)).toEqual(exchange);
  });
});
