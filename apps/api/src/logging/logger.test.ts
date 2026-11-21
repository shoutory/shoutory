import { SealedSecret } from "@shoutory/core/crypto";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger, logRequest } from "./logger.js";

// Planted values are descriptive and low-entropy (AGENTS 4.13). The canary holds characters that every encoding changes.
const CANARY = 'log-canary"v\\1/a b+c=d';
const KEK = Buffer.from("planted-kek-for-logger-tests-0001").toString("base64");
const SUBKEY = Buffer.from("planted-subkey-for-logger-tests!").toString("hex");
const SECRETS = [CANARY, KEK, SUBKEY];

const forms = {
  raw: (v: string) => v,
  percent: (v: string) => encodeURIComponent(v),
  hex: (v: string) => Buffer.from(v).toString("hex"),
  base64: (v: string) => Buffer.from(v).toString("base64"),
  jsonEscaped: (v: string) => JSON.stringify(v).slice(1, -1),
};

function capture(secrets: readonly string[] = SECRETS): { log: Logger; lines: string[]; make: () => Logger } {
  const lines: string[] = [];
  const make = () => createLogger({ secrets, stream: { write: (line) => lines.push(line) } });
  return { log: make(), lines, make };
}

// Every string value of the parsed line: a planted JSON-escaped form is one level of escaping away from the
// raw line, so the raw text alone cannot show that form absent.
function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(stringValues);
}

function expectNoneOf(lines: string[], secrets: readonly string[]): void {
  expect(lines).toHaveLength(1);
  const texts = [lines[0] ?? "", ...stringValues(JSON.parse(lines[0] ?? "null"))];
  for (const secret of secrets) {
    for (const [form, encode] of Object.entries(forms)) {
      for (const text of texts) expect(text, `${form} form of a planted value`).not.toContain(encode(secret));
    }
  }
}

type Surface = (logger: Logger, value: string) => void;
const surfaces: Record<string, Surface> = {
  "top level": (l, v) => l.info({ value: v }, "event"),
  nested: (l, v) => l.info({ a: { value: v } }, "event"),
  "three levels deep": (l, v) => l.info({ a: { b: { c: { value: v } } } }, "event"),
  "child bindings": (l, v) => l.child({ value: v }).info({}, "event"),
  "message string": (l, v) => l.info({}, `failed with ${v}`),
  "error cause": (l, v) => l.error({ err: new Error("outer", { cause: new Error(v) }) }, "event"),
  "error message": (l, v) => l.error({ err: new Error(`bad ${v} here`) }, "event"),
  "url path": (l, v) => l.info({ target: `/hooks/${v}/deliver` }, "event"),
};

describe("a canary never appears in a log line or serialized error", () => {
  const rows = Object.keys(surfaces).flatMap((surface) =>
    SECRETS.flatMap((secret, index) =>
      Object.entries(forms).map(([form, encode]) => ({ surface, index, form, value: encode(secret) })),
    ),
  );
  it.each(rows)("$surface, secret $index planted as $form", ({ surface, value }) => {
    const { log, lines } = capture();
    surfaces[surface]?.(log, value);
    expectNoneOf(lines, SECRETS);
  });

  it("a SealedSecret field never prints its value", () => {
    const { log, lines } = capture();
    log.info({ credential: new SealedSecret(CANARY) }, "event");
    expectNoneOf(lines, SECRETS);
  });
});

describe("the scrubber's bounds and failure modes", () => {
  it("depth 9 is cut with a [truncated] marker", () => {
    const { log, lines } = capture();
    let deep: object = { leaf: "reached" };
    for (let i = 0; i < 9; i++) deep = { next: deep };
    log.info(deep, "event");
    expect(lines[0]).toContain("[truncated]");
    expect(lines[0]).not.toContain("reached");
  });

  it("a circular reference ends and the line is still written", () => {
    const { log, lines } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    log.info(loop, "event");
    expect(lines).toHaveLength(1);
  });
});

describe("the scrubber's caps, masking and failure mode", () => {
  it("an array past 100 entries is cut with a [N more] marker", () => {
    const { log, lines } = capture();
    log.info({ items: Array.from({ length: 150 }, (_, i) => `item-${i}-end`) }, "event");
    expect(lines[0]).toContain("[50 more]");
    expect(lines[0]).toContain("item-99-end");
    expect(lines[0]).not.toContain("item-100-end");
  });

  it("an object past 100 keys is cut with a [N more] marker", () => {
    const { log, lines } = capture();
    log.info({ fields: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`key${i}x`, i])) }, "event");
    expect(lines[0]).toContain("[50 more]");
    expect(lines[0]).toContain("key99x");
    expect(lines[0]).not.toContain("key100x");
  });

  it("an empty or short registered value masks nothing, a long one beside it still does", () => {
    const { log, lines } = capture(["", "abc", CANARY]);
    log.info({ note: `abc stays, ${CANARY} goes` }, "abc event");
    expect(lines[0]).toContain("abc stays");
    expect(lines[0]).toContain("abc event");
    expectNoneOf(lines, [CANARY]);
  });

  it.each(Object.entries(forms))("an Error stack carries no planted %s form", (_form, encode) => {
    const { log, lines } = capture();
    const err = new Error("outer");
    err.stack = `Error: outer\n    at handler (${encode(CANARY)})`;
    log.error({ err }, "event");
    expectNoneOf(lines, SECRETS);
  });

  it("a scrub failure writes a fixed marker line and never the raw value", () => {
    const { log, lines } = capture();
    const hostile = {
      get poison(): string {
        throw new Error(CANARY);
      },
    };
    expect(() => log.info(hostile, "event")).not.toThrow();
    expect(lines.map((line) => line.trim())).toEqual([
      JSON.stringify({ level: "error", msg: "[log line withheld]" }),
    ]);
  });
});

describe("every redacted key (authorization, cookie, token and the rest) is redacted", () => {
  const keys = [
    "authorization",
    "cookie",
    "set-cookie",
    "token",
    "secret",
    "password",
    "apiKey",
    "newPassword",
    "currentPassword",
    "totpURI",
    "backupCodes",
  ];
  const variants = (key: string) => [
    key,
    key.toUpperCase(),
    key.toLowerCase(),
    `${key[0]?.toUpperCase()}${key.slice(1)}`,
  ];
  const shapes: Record<string, (key: string, v: string) => object> = {
    "top level": (k, v) => ({ [k]: v }),
    "three levels deep": (k, v) => ({ a: { b: { c: { [k]: v } } } }),
  };
  const rows = keys.flatMap((key) =>
    variants(key).flatMap((variant) => Object.keys(shapes).map((shape) => ({ variant, shape }))),
  );
  it.each(rows)("$variant at $shape", ({ variant, shape }) => {
    const { log, lines } = capture([]);
    log.info(shapes[shape]?.(variant, "unregistered-value-for-key-rows") ?? {}, "event");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("unregistered-value-for-key-rows");
  });
});

describe("SMTP URL userinfo, database URL and password values are redacted", () => {
  const password = "pa ss/word@1";
  const rows: Record<string, (l: Logger) => void> = {
    "SMTP URL": (l) =>
      l.info({ url: `smtps://mailer:${encodeURIComponent(password)}@mail.example.test:465` }, "event"),
    "database URL": (l) =>
      l.info(
        { url: `postgres://app:${encodeURIComponent(password)}@db.example.test:5432/shoutory` },
        "event",
      ),
    "password variable": (l) => l.info({ SHOUTORY_DATABASE_PASSWORD_APP: password }, "event"),
  };
  it.each(Object.keys(rows))("%s", (name) => {
    const { log, lines } = capture([password]);
    rows[name]?.(log);
    expectNoneOf(lines, [password]);
  });
});

describe("a credential in a URL path or query is redacted in request logs", () => {
  const rows = [
    {
      name: "presigned query",
      url: "/media/a.png?X-Amz-Signature=signature-value-0001&X-Amz-Credential=credential-value-0001",
      secret: "signature-value-0001",
    },
    ...["share", "token", "verify", "reset", "invite", "unsubscribe", "signed"].map((prefix) => ({
      name: `path segment after ${prefix}`,
      url: `/${prefix}/segment-value-0001/more`,
      secret: "segment-value-0001",
    })),
    { name: "a percent-encoded prefix", url: "/%73hare/segment-value-0001", secret: "segment-value-0001" },
    { name: "an upper-case prefix", url: "/SHARE/segment-value-0001", secret: "segment-value-0001" },
    { name: "a fragment", url: "/page#fragment-value-0001", secret: "fragment-value-0001" },
    {
      name: "a fragment on an absolute URL",
      url: "https://example.test/page#fragment-value-0001",
      secret: "fragment-value-0001",
    },
    ...[
      "token",
      "code",
      "key",
      "signature",
      "sig",
      "secret",
      "password",
      "X-Amz-Credential",
      "X-Amz-Security-Token",
      "access_token",
      "refresh_token",
      "id_token",
      "client_secret",
      "api_key",
    ].map((param) => ({
      name: `query parameter ${param}`,
      url: `/callback?${param}=query-value-0001&next=%2F`,
      secret: "query-value-0001",
    })),
    ...["TOKEN", "Token", "X-AMZ-SIGNATURE"].map((param) => ({
      name: `case variant ${param}`,
      url: `/callback?${param}=query-value-0001`,
      secret: "query-value-0001",
    })),
    {
      name: "URL userinfo",
      url: "https://mailer:userinfo-value-0001@example.test/hooks",
      secret: "userinfo-value-0001",
    },
  ];
  it.each(rows)("$name", ({ url, secret }) => {
    const { log, lines } = capture([]);
    logRequest(log, { method: "GET", url, status: 200 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain("GET");
    expect(lines[0]).toContain("200");
  });
});

describe("an unparsable request target is logged as a fixed value and never throws", () => {
  it.each(["//", "http://", "///", "", "no-slash?token=query-value-0001"])("%j", (url) => {
    const { log, lines } = capture([]);
    expect(() => logRequest(log, { method: "GET", url, status: 400 })).not.toThrow();
    expect(lines[0]).toContain("[unparsable]");
    expect(lines[0]).not.toContain("query-value-0001");
  });
});

describe("a query error that echoes its parameters", () => {
  it("is logged without message, stack, query and params, and keeps its type and its cause", () => {
    const { log, lines } = capture([]);
    const driver = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    // The shape of Drizzle's query error: SQL and parameters in the message, the driver error only in `cause`.
    const failed = Object.assign(
      new Error(
        "Failed query: insert into account\nparams: hash-value-not-registered-1,mail-not-registered-1",
        {
          cause: driver,
        },
      ),
      { name: "DrizzleQueryError", query: "insert into account", params: ["hash-value-not-registered-1"] },
    );
    log.error({ err: failed }, "request failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("not-registered-1");
    expect(lines[0]).toContain("DrizzleQueryError");
    expect(lines[0]).toContain("connection refused");
  });
});
