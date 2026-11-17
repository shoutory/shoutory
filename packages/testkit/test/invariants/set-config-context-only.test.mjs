import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CONTEXT_DIR = "packages/db/src/context/";
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const GLOBS = ["{apps,packages}/**/*.{ts,tsx,mts,js,cjs,mjs,sql}"];
const EXTENSIONS = ["ts", "tsx", "mts", "js", "cjs", "mjs", "sql"];
// The words are joined here so this file never matches its own scan (it is under test/, which is exempt anyway).
const SET_CONFIG = "set_" + "config";
const FUNCTION_CALL = /\bset_config\s*\(/i;
const SET_STATEMENT = /\bSET\s+(?:LOCAL\s+|SESSION\s+)?app\./i;
const ALTERED_DEFAULT = /\bALTER\s+(?:ROLE|DATABASE)\b[^;]*\bSET\s+app\./i;
// Migrations may set only the job purpose: a definer function does it at entry.
const ALLOWED_IN_SQL = /\bset_config\s*\(\s*'app\.job_purpose'|\bSET\s+(?:LOCAL\s+)?app\.job_purpose\b/gi;

function inTestFile(file) {
  return file.split("/").includes("test") || /\.test\.(ts|tsx|mts|js|cjs|mjs)$/.test(file);
}

function scannedFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return GLOBS.flatMap((pattern) => globSync(pattern, { cwd: base, exclude }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith(CONTEXT_DIR) && !inTestFile(file));
}

function violates(file, text) {
  if (ALTERED_DEFAULT.test(text)) return true;
  if (!file.endsWith(".sql")) return FUNCTION_CALL.test(text) || SET_STATEMENT.test(text);
  const code = text.replace(/--[^\n]*/g, "").replace(ALLOWED_IN_SQL, "");
  return FUNCTION_CALL.test(code) || SET_STATEMENT.test(code);
}

const offenders = (base) =>
  scannedFiles(base).filter((file) => violates(file, readFileSync(join(base, file), "utf8")));

test("raw set_config appears only under packages/db/src/context", () => {
  assert.ok(scannedFiles(root).length >= 10, "fewer than 10 files were scanned");
  assert.deepEqual(offenders(root), []);
});

function plant(files) {
  const base = mkdtempSync(join(tmpdir(), "set-config-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), content);
  }
  return base;
}

const CALL = `await db.query("SELECT ${SET_CONFIG}($1, $2, true)");\n`;
const FLAGGED = [
  ...EXTENSIONS.map((ext) => [`a .${ext} file calls the function`, `packages/db/src/planted.${ext}`, CALL]),
  ["upper case", "apps/api/src/up.ts", CALL.toUpperCase()],
  ["a space before the parenthesis", "apps/api/src/space.ts", `x("${SET_CONFIG} (a, b, true)");\n`],
  ["SET LOCAL in a ts string", "apps/api/src/local.ts", 'x("SET LOCAL app.workspace_ids = 1");\n'],
  ["SET SESSION in a ts string", "apps/api/src/session.ts", 'x("SET SESSION app.principal_kind = 1");\n'],
  ["SET in a migration", "packages/db/migrations/9999_x.sql", "SET LOCAL app.workspace_ids = '{}';\n"],
  [
    "another setting through the function in a migration",
    "packages/db/migrations/9998_x.sql",
    `SELECT ${SET_CONFIG}('app.workspace_ids', 'x', true);\n`,
  ],
  ["ALTER ROLE", "packages/db/migrations/9997_x.sql", "ALTER ROLE shoutory_app SET app.job_purpose = 'x';\n"],
  [
    "ALTER DATABASE",
    "packages/db/migrations/9996_x.sql",
    "ALTER DATABASE shoutory SET app.workspace_ids = 'x';\n",
  ],
  ["a script under scripts-like package folder", "packages/testkit/scripts/x.mjs", CALL],
];
for (const [title, file, content] of FLAGGED) {
  test(`the scan flags a planted call: ${title}`, () => {
    const base = plant({ [file]: content });
    try {
      assert.deepEqual(offenders(base), [file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

const SPARED = [
  ["the context folder", `${CONTEXT_DIR}with-tenant.ts`, CALL],
  ["a test folder", "packages/db/test/integration/x.ts", CALL],
  ["a .test.ts file beside its code", "packages/db/src/x.test.ts", CALL],
  [
    "a migration setting the job purpose through the function",
    "packages/db/migrations/9995_x.sql",
    `SELECT ${SET_CONFIG}('app.job_purpose', 'x', true);\n`,
  ],
  [
    "a migration with SET LOCAL of the job purpose",
    "packages/db/migrations/9994_x.sql",
    "SET LOCAL app.job_purpose = 'x';\n",
  ],
  [
    "a migration comment that names the function",
    "packages/db/migrations/9993_x.sql",
    `-- ${SET_CONFIG}('app.workspace_ids') is withTenant's job\nSELECT 1;\n`,
  ],
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
