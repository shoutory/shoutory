import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const HELPER = "packages/db/src/locks.ts";
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const GLOBS = ["{apps,packages,scripts,e2e,docker}/**/*.{ts,tsx,mts,cts,js,mjs,cjs,sql,sh}"];
// The function names are joined here so this file never matches its own scan.
const NAMES = [
  "pg_" + "advisory_lock",
  "pg_try_" + "advisory_lock",
  "pg_" + "advisory_xact_lock",
  "pg_" + "advisory_unlock",
  "pg_" + "advisory_unlock_all",
  "pg_" + "advisory_lock_shared",
];
const FORBIDDEN = /\bpg_(try_)?advisory_(xact_)?(lock|unlock)(_shared|_all)?\b/i;

function scannedFiles(base) {
  const exclude = (name) => SKIPPED.has(name);
  return GLOBS.flatMap((pattern) => globSync(pattern, { cwd: base, exclude }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file !== HELPER);
}

const offenders = (base) =>
  scannedFiles(base).filter((file) => FORBIDDEN.test(readFileSync(join(base, file), "utf8")));

test("advisory locks are taken only through withAdvisoryLock", () => {
  assert.ok(scannedFiles(root).length >= 10, "fewer than 10 files were scanned");
  assert.deepEqual(offenders(root), []);
});

for (const [title, file, content] of [
  [
    "upper-case in a ts file",
    "apps/api/src/up.ts",
    `await db.query("SELECT ${NAMES[0].toUpperCase()}(1)");\n`,
  ],
  ["mixed case in a sql file", "docker/postgres/mixed.sql", `SELECT P${"g_Advisory_"}Lock(1);\n`],
  ...["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "sql", "sh"].map((ext) => [
    `a .${ext} file`,
    `packages/db/src/planted.${ext}`,
    `run "SELECT ${NAMES[1]}(1)"\n`,
  ]),
]) {
  test(`the scan flags a planted call in ${title}`, () => {
    const base = mkdtempSync(join(tmpdir(), "advisory-locks-"));
    try {
      mkdirSync(dirname(join(base, file)), { recursive: true });
      writeFileSync(join(base, file), content);
      assert.deepEqual(offenders(base), [file]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("the scan flags a direct call in every lock form and spares the helper", () => {
  const base = mkdtempSync(join(tmpdir(), "advisory-locks-"));
  try {
    mkdirSync(join(base, "apps/api/src"), { recursive: true });
    mkdirSync(join(base, "packages/db/src"), { recursive: true });
    for (const [index, name] of NAMES.entries()) {
      writeFileSync(join(base, `apps/api/src/planted-${index}.ts`), `await db.query("SELECT ${name}(1)");\n`);
    }
    writeFileSync(join(base, HELPER), `await db.query("SELECT ${NAMES[0]}(1)");\n`);
    assert.equal(offenders(base).length, NAMES.length);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
