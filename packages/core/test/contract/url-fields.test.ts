import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { URL_FIELDS, type UrlField } from "../../src/net/url-fields.js";

const root = resolve(import.meta.dirname, "../../../..");
const exceptionIds: string[] = (
  JSON.parse(
    readFileSync(join(root, "packages/testkit/test/invariants/egress-operator-exceptions.json"), "utf8"),
  ) as { id: string }[]
).map((row) => row.id);

const FIELD_IDS = [
  "server-instance-url",
  "media-import",
  "provider-issuer",
  "s3-endpoint",
  "s3-public-endpoint",
  "clamav-host",
  "smtp-url",
  "otlp-endpoint",
  "mail-check-dns",
];

function readerProblem(id: string, reader: string | undefined, base: string): string[] {
  if (reader === undefined) return [`${id}: egress row with no reader`];
  const path = join(base, reader);
  if (!existsSync(path)) return [`${id}: reader does not exist`];
  return /\bimport\b[^;]*\begressFetch\b/.test(readFileSync(path, "utf8"))
    ? []
    : [`${id}: reader does not import egressFetch`];
}

function problems(
  fields: readonly Partial<UrlField>[],
  knownExceptionIds: readonly string[],
  base = root,
): string[] {
  const seen = new Set<string>();
  return fields.flatMap((field) => {
    const id = field.id ?? "(no id)";
    const found: string[] = [];
    if (seen.has(id)) found.push(`${id}: duplicate id`);
    seen.add(id);
    if (field.route !== "egress" && field.route !== "operator_exception") found.push(`${id}: no guard route`);
    if (field.route === "operator_exception" && !knownExceptionIds.includes(field.exceptionId ?? ""))
      found.push(`${id}: exception id missing from the exceptions list`);
    if (field.route === "egress" && field.exceptionId !== undefined)
      found.push(`${id}: egress row with an exception id`);
    if (field.route === "egress") found.push(...readerProblem(id, field.reader, base));
    return found;
  });
}

describe("every URL field names a guard route", () => {
  it("lists the whole set of URL fields, each with a route, and each exception id is in the exceptions list", () => {
    expect(URL_FIELDS.map((field) => field.id).sort()).toEqual([...FIELD_IDS].sort());
    expect(problems(URL_FIELDS, exceptionIds)).toEqual([]);
  });

  it("routes the user-supplied fields through egress and the operator-configured drivers to exception rows", () => {
    const route = (id: string) => URL_FIELDS.find((field) => field.id === id)?.route;
    expect(["server-instance-url", "media-import", "provider-issuer"].map(route)).toEqual(
      Array(3).fill("egress"),
    );
    expect(
      ["s3-endpoint", "s3-public-endpoint", "clamav-host", "smtp-url", "otlp-endpoint", "mail-check-dns"].map(
        route,
      ),
    ).toEqual(Array(6).fill("operator_exception"));
  });

  it.each([
    ["a field with no route", [{ id: "x" }], ["x: no guard route"]],
    [
      "an exception id missing from the list",
      [{ id: "x", route: "operator_exception", exceptionId: "nope" }],
      ["x: exception id missing from the exceptions list"],
    ],
    [
      "an exception row with no exception id",
      [{ id: "x", route: "operator_exception" }],
      ["x: exception id missing from the exceptions list"],
    ],
    ["an egress row with no reader", [{ id: "x", route: "egress" }], ["x: egress row with no reader"]],
    [
      "an egress row whose reader is missing",
      [{ id: "x", route: "egress", reader: "apps/api/src/gone.ts" }],
      ["x: reader does not exist"],
    ],
    [
      "an egress row whose reader does not import egressFetch",
      [{ id: "x", route: "egress", reader: "apps/api/src/app.ts" }],
      ["x: reader does not import egressFetch"],
    ],
  ] as const)("fails for %s", (_name, fields, expected) => {
    expect(problems(fields, exceptionIds)).toEqual(expected);
  });
});

const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts"]);
// The three schemas outside the API that never name a host to connect to: a docs link in a manifest, a redirect target in
// the test OAuth server, and the otpauth URI the sign-in app shows as a QR code.
const SCHEMA_ALLOWLIST: readonly { path: string; reason: string }[] = [
  {
    path: "packages/provider-sdk/src/manifest/manifest.ts",
    reason: "Documentation links the manifest cites; nothing fetches them.",
  },
  {
    path: "packages/testkit/src/oauth-fake/server.ts",
    reason: "The OAuth test server checks a redirect target the test itself chose; it is never fetched.",
  },
  {
    path: "packages/core/src/connect/flow.ts",
    reason:
      "The issuer an adapter found through its own egress client; it is fetched again only through that client.",
  },
  {
    path: "packages/core/src/channels/credential.ts",
    reason: "The issuer stored with a token; an adapter fetches it only through the provider egress client.",
  },
  {
    path: "apps/web/src/auth/two-factor-setup.tsx",
    reason: "The otpauth URI of a TOTP secret, shown as a QR code and never fetched.",
  },
];
// A new URL schema in the API or a package, or a `*_url` column in a migration, is a field that needs a registry row first.
const ZOD_URL = /\bz\s*\.\s*(?:url|httpUrl)\s*\(|\.url\s*\(\s*\)/;
const SOURCES = ["apps/{api,web}/src/**/*.{ts,tsx}", "packages/{*,providers/*}/src/**/*.{ts,tsx}"];
const URL_COLUMN = /\b[a-z][a-z0-9_]*_url\b/i;

function unregisteredSites(base: string): string[] {
  const exclude = (name: string) => SKIPPED.has(name);
  const api = globSync(SOURCES, { cwd: base, exclude })
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) =>
        !/.test.tsx?$/.test(file) &&
        !SCHEMA_ALLOWLIST.some((row) => row.path === file) &&
        ZOD_URL.test(readFileSync(join(base, file), "utf8")),
    );
  const sql = globSync("packages/db/migrations/*.sql", { cwd: base, exclude })
    .map((file) => file.replaceAll("\\", "/"))
    // Comments are not columns, and neither is the credential kind `webhook_url`, an enum value: only that literal is
    // blanked, so any other `*_url` name, quoted or not, is still found.
    .filter((file) =>
      URL_COLUMN.test(
        readFileSync(join(base, file), "utf8")
          .replace(/--[^\n]*/g, "")
          .replaceAll("'webhook_url'", "''"),
      ),
    );
  return [...api, ...sql];
}

function plant(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "url-fields-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

describe("the tripwire for a new URL field", () => {
  it("every allowlisted schema file exists, holds a URL schema and has a reason", () => {
    for (const row of SCHEMA_ALLOWLIST) {
      expect(row.reason.trim(), row.path).not.toBe("");
      expect(ZOD_URL.test(readFileSync(join(root, row.path), "utf8")), row.path).toBe(true);
    }
  });

  it("finds no unregistered URL schema in the sources and no *_url column in a migration", () => {
    expect(unregisteredSites(root)).toEqual([]);
  });

  it.each([
    ["a z.url( schema", "apps/api/src/routes/x.ts", "const s = z.url({ protocol: /^https$/ });\n"],
    ["a chained .url() string", "apps/api/src/routes/y.ts", "const s = z.string().url();\n"],
    ["a z.url( schema in a package", "packages/core/src/x.ts", "const s = z.url();\n"],
    ["a z.url( schema in a provider package", "packages/providers/x/src/x.ts", "const s = z.url();\n"],
    ["a z.url( schema in the web app", "apps/web/src/x.tsx", "const s = z.url();\n"],
    [
      "a *_url column",
      "packages/db/migrations/9999_x.sql",
      "ALTER TABLE app.t ADD COLUMN webhook_url text;\n",
    ],
  ])("flags %s", (_name, file, content) => {
    const base = plant({ [file]: content });
    try {
      expect(unregisteredSites(base)).toEqual([file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("spares a test file and a comment-only mention in a migration", () => {
    const base = plant({
      "apps/api/src/routes/x.test.ts": "z.url();\n",
      "packages/db/migrations/9998_x.sql": "-- a docs_url column is not added here\nSELECT 1;\n",
    });
    try {
      expect(unregisteredSites(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
