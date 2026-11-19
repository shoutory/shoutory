import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Flags are read through one path: the loader of apps/api/src/flags asks the definer, and code asks `flags.isOn`.
// Any other mention of the flag tables or of the definer that reads them, outside migrations, the table metadata, the
// loader folder and tests, is a second read path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const EXTENSIONS = ["ts", "tsx", "mts", "js", "cjs", "mjs", "sql"];
const EXEMPT = ["packages/db/migrations/", "packages/db/src/schema.ts", "apps/api/src/flags/"];
const PATTERN = /\b(?:feature_flags|feature_flag_overrides|flags_read)\b/;

const inTestFile = (file) =>
  file.split("/").includes("test") || /\.test\.(ts|tsx|mts|js|cjs|mjs)$/.test(file);

function scannedFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return globSync(`{apps,packages}/**/*.{${EXTENSIONS.join(",")}}`, { cwd: base, exclude })
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !inTestFile(file) && !EXEMPT.some((prefix) => file.startsWith(prefix)))
    .sort();
}

const offenders = (base) =>
  scannedFiles(base).filter((file) => PATTERN.test(readFileSync(join(base, file), "utf8")));

test("the flag tables are read only through the loader", () => {
  assert.ok(scannedFiles(root).length >= 10, "fewer than 10 files were scanned");
  assert.deepEqual(offenders(root), []);
});

function plant(files) {
  const base = mkdtempSync(join(tmpdir(), "flags-read-path-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

const FLAGGED = [
  ["a query of the flag table", "apps/api/src/a.ts", 'await tx.query("SELECT * FROM app.feature_flags");\n'],
  ["a query of the override table", "packages/core/src/b.ts", "const t = 'app.feature_flag_overrides';\n"],
  [
    "a call of the read definer outside the loader",
    "apps/api/src/routes/c.ts",
    'q("SELECT * FROM app.flags_read()");\n',
  ],
  ["a sql file beside the code", "packages/db/src/d.sql", "SELECT * FROM app.feature_flags;\n"],
];
for (const [title, file, content] of FLAGGED) {
  test(`the scan flags a planted read: ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(offenders(base), [file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

const SPARED = [
  ["the loader folder", "apps/api/src/flags/load.ts", "q('FROM app.flags_read()');\n"],
  ["a migration", "packages/db/migrations/9999_x.sql", "INSERT INTO app.feature_flags (key) VALUES ('a');\n"],
  ["the table metadata", "packages/db/src/schema.ts", 'app.table("feature_flags", {});\n'],
  ["a test folder", "packages/db/test/integration/x.ts", "q('app.feature_flags');\n"],
];
for (const [title, file, content] of SPARED) {
  test(`the scan spares ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(offenders(base), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
