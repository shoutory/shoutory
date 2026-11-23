import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The H3 list (NFR-SEC-11): a field a user or an operator can point at a host.
const H3_IDS = [
  "server-instance-url",
  "identity-server-url",
  "identity-handle",
  "site-url",
  "oidc-issuer",
  "cimd",
  "webhook-target",
  "notification-webhook",
  "ai-base-url",
  "shortener-host",
  "media-import",
  "rss",
  "s3-endpoint",
  "s3-public-endpoint",
  "smtp-url",
  "otlp-endpoint",
  "mail-check-dns",
];

/** What is wrong with a registry: a field with no guard route, or an exception id the exceptions list lacks. */
function problems(fields: readonly Partial<UrlField>[], knownExceptionIds: readonly string[]): string[] {
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
    if (!field.milestone) found.push(`${id}: no milestone`);
    return found;
  });
}

describe("every URL field names a guard route (NFR-SEC-11, H3)", () => {
  it("lists the whole H3 set, each with a route, and each exception id is in the exceptions list", () => {
    expect(URL_FIELDS.map((field) => field.id).sort()).toEqual([...H3_IDS].sort());
    expect(problems(URL_FIELDS, exceptionIds)).toEqual([]);
  });

  it("routes the user-supplied fields through egress and the operator-configured drivers to exception rows", () => {
    const route = (id: string) => URL_FIELDS.find((field) => field.id === id)?.route;
    expect(
      ["server-instance-url", "webhook-target", "media-import", "rss", "ai-base-url"].map(route),
    ).toEqual(Array(5).fill("egress"));
    expect(
      ["s3-endpoint", "s3-public-endpoint", "smtp-url", "otlp-endpoint", "mail-check-dns"].map(route),
    ).toEqual(Array(5).fill("operator_exception"));
  });

  it.each([
    ["a field with no route", [{ id: "x", milestone: "M9" }], ["x: no guard route"]],
    [
      "an exception id missing from the list",
      [{ id: "x", route: "operator_exception", exceptionId: "nope", milestone: "M9" }],
      ["x: exception id missing from the exceptions list"],
    ],
    [
      "an exception row with no exception id",
      [{ id: "x", route: "operator_exception", milestone: "M9" }],
      ["x: exception id missing from the exceptions list"],
    ],
    ["a field with no milestone", [{ id: "x", route: "egress" }], ["x: no milestone"]],
  ] as const)("fails for %s", (_name, fields, expected) => {
    expect(problems(fields, exceptionIds)).toEqual(expected);
  });
});

const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts"]);
// A new URL schema in the API, or a `*_url` column in a migration, is a field that needs a registry row first.
const ZOD_URL = /\bz\s*\.\s*(?:url|httpUrl)\s*\(|\.url\s*\(\s*\)/;
const URL_COLUMN = /\b[a-z][a-z0-9_]*_url\b/i;

function unregisteredSites(base: string): string[] {
  const exclude = (name: string) => SKIPPED.has(name);
  const api = globSync("apps/api/src/**/*.ts", { cwd: base, exclude })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".test.ts") && ZOD_URL.test(readFileSync(join(base, file), "utf8")));
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
  it("finds no unregistered URL schema in apps/api/src and no *_url column in a migration", () => {
    expect(unregisteredSites(root)).toEqual([]);
  });

  it.each([
    ["a z.url( schema", "apps/api/src/routes/x.ts", "const s = z.url({ protocol: /^https$/ });\n"],
    ["a chained .url() string", "apps/api/src/routes/y.ts", "const s = z.string().url();\n"],
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
