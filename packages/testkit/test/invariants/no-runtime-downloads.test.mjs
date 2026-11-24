import { strict as assert } from "node:assert";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
// The words are joined here so this file never matches its own scan.
const WORDS = ["np" + "x", "dl" + "x", "core" + "pack"];
const FORBIDDEN = new RegExp(`\\b(${WORDS.join("|")})\\b`);
const SKIPPED = new Set(["node_modules", "dist", ".git", ".artifacts", ".turbo"]);
const GLOBS = ["scripts/**/*", ".github/workflows/*", "docker/**/*", "**/Dockerfile*"];

function scanned(base) {
  const exclude = (name) => SKIPPED.has(name);
  const files = GLOBS.flatMap((pattern) => globSync(pattern, { cwd: base, exclude }));
  const texts = [...new Set(files)]
    .filter((file) => statSync(join(base, file)).isFile())
    .map((file) => ({ file, text: readFileSync(join(base, file), "utf8") }));
  for (const file of globSync("**/package.json", { cwd: base, exclude })) {
    const { scripts = {} } = JSON.parse(readFileSync(join(base, file), "utf8"));
    texts.push({ file, text: Object.values(scripts).join("\n") });
  }
  return texts;
}

const offenders = (base) =>
  scanned(base)
    .filter(({ text }) => FORBIDDEN.test(text))
    .map(({ file }) => file.replaceAll("\\", "/"));

test("no script, workflow, package script or Dockerfile downloads a tool at run time", () => {
  assert.ok(scanned(root).length >= 1, "no file was scanned");
  assert.deepEqual(offenders(root), []);
});

test("the scan flags a fixture that uses a runtime download", () => {
  const base = mkdtempSync(join(tmpdir(), "downloads-"));
  try {
    mkdirSync(join(base, "scripts"));
    writeFileSync(join(base, "scripts/run.sh"), `${WORDS[0]} tool\n`);
    writeFileSync(join(base, "package.json"), JSON.stringify({ scripts: { go: `pnpm ${WORDS[1]} tool` } }));
    assert.deepEqual(offenders(base).sort(), ["package.json", "scripts/run.sh"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
