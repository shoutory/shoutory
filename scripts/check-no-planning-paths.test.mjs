import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = resolve(dirname(fileURLToPath(import.meta.url)), "check-no-planning-paths.mjs");

// Planted values are assembled at run time so this file never contains them literally.
const planted = {
  "a planning path": ["see ", "docs", "/", "plans", "/x for details"].join(""),
  "an ADR number": ["decided in ", "AD", "R-", "12"].join(""),
  "a slice id": ["built in ", "M", "3-", "07"].join(""),
  "a plan label": ["label ", "OD", "-M", "4"].join(""),
};

function runGuard(files) {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    return spawnSync(process.execPath, [guard], { cwd: dir, encoding: "utf8" }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [label, line] of Object.entries(planted)) {
  test(`the guard exits non-zero for ${label} in a tracked file`, () => {
    assert.notEqual(runGuard({ "src/note.txt": `${line}\n` }), 0);
  });
}

test("the guard exits non-zero for a tracked file whose path is a planning path", () => {
  assert.notEqual(runGuard({ [["docs", "prd", "a.md"].join("/")]: "plain text\n" }), 0);
});

test("the guard exits zero for a clean tree", () => {
  assert.equal(runGuard({ "src/index.txt": "plain text\n", "README.txt": "hello\n" }), 0);
});

test("the guard ignores untracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "loose.txt"), `${planted["a slice id"]}\n`);
    assert.equal(spawnSync(process.execPath, [guard], { cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
