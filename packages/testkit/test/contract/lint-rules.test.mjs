import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const biome = join(root, "node_modules/@biomejs/biome/bin/biome");

// The fixture lives in a temporary directory that holds only a copy of the repository's biome.json.
function lint(path, code) {
  const dir = mkdtempSync(join(tmpdir(), "lint-fixture-"));
  try {
    copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), code);
    const run = spawnSync(process.execPath, [biome, "lint", "--vcs-enabled=false", path], {
      cwd: dir,
      encoding: "utf8",
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const src = "apps/api/src/fixture.ts";
const imp = (from) => `import * as m from "${from}";\nexport { m };\n`;
const longBody = Array.from({ length: 52 }, (_, i) => `  const v${i} = ${i};`).join("\n");
const nested = Array.from({ length: 12 }, (_, i) => `if (a > ${i}) { if (b > ${i}) { c += 1; } }`).join("\n");

// Each row must be refused by the named rule; a rule missing from biome.json makes its row pass and fail the test.
const REFUSED = [
  ["console in src", src, 'console.log("x");\n', "suspicious/noConsole"],
  ["Math.random in src", src, "export const n = Math.random();\n", "noJsRestrictedProperties"],
  ["a function over 50 lines", src, `export function f() {\n${longBody}\n}\n`, "noExcessiveLinesPerFunction"],
  ["an empty catch", src, "try { f(); } catch (e) {}\n", "noEmptyBlockStatements"],
  ["a catch that only rethrows", src, "try { f(); } catch (e) { throw e; }\n", "noUselessCatch"],
  [
    "cognitive complexity over the limit",
    src,
    `export function g(a, b) {\n  let c = 0;\n${nested}\n  return c;\n}\n`,
    "noExcessiveCognitiveComplexity",
  ],
  ["hono jwt", src, imp("hono/jwt"), "noRestrictedImports"],
  ["hono cors", src, imp("hono/cors"), "noRestrictedImports"],
  ["hono serve-static", src, imp("hono/serve-static"), "noRestrictedImports"],
  ["node-server serve-static", src, imp("@hono/node-server/serve-static"), "noRestrictedImports"],
  ["hono aws-lambda", src, imp("hono/aws-lambda"), "noRestrictedImports"],
  ["react-router dev", src, imp("@react-router/dev/vite"), "noRestrictedImports"],
  ["a plugin outside the allowlist", src, imp("better-auth/plugins/organization"), "noRestrictedImports"],
];

for (const [label, path, code, rule] of REFUSED) {
  test(`lint refuses ${label}`, () => {
    const { status, output } = lint(path, code);
    assert.notEqual(status, 0, output);
    assert.ok(output.includes(rule), output);
  });
}

const ALLOWED = [
  ["console in scripts", "scripts/fixture.mjs", 'console.log("x");\n'],
  ["Math.random outside src", "packages/testkit/test/fixture.mjs", "export const n = Math.random();\n"],
  ["the allowed better-auth two-factor plugin", src, imp("better-auth/plugins/two-factor")],
  ["a catch that handles the error", src, "try { f(); } catch (e) { handle(e); }\n"],
];

for (const [label, path, code] of ALLOWED) {
  test(`lint accepts ${label}`, () => {
    const { status, output } = lint(path, code);
    assert.equal(status, 0, output);
  });
}
