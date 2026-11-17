import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlaceholders, runSteps, STEPS } from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ok = [process.execPath, "-e", ""];
const bad = [process.execPath, "-e", "process.exit(3)"];

function run(steps, { files = {}, placeholders = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    const lines = [];
    const status = runSteps(steps, { cwd, placeholders, log: (line) => lines.push(line) });
    return { status, output: lines.join("\n") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const withFile = { files: { "src/a.txt": "a" } };

test("a passing step prints the files it ran", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: ok }], withFile);
  assert.equal(status, 0);
  assert.match(output, /alpha/);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a failing step prints its files and fails the run", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: bad }], withFile);
  assert.notEqual(status, 0);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a step that ran nothing fails unless it is a listed placeholder", () => {
  const steps = [{ name: "beta", globs: ["none/*.txt"], command: ok }];
  const failing = run(steps);
  assert.notEqual(failing.status, 0);
  assert.match(failing.output, /beta/);
  assert.equal(run(steps, { placeholders: ["beta"] }).status, 0);
});

test("a skipped step fails unless it is a listed placeholder", () => {
  const steps = [{ name: "gamma", globs: ["src/*.txt"], command: ok, skip: "not run" }];
  assert.notEqual(run(steps, withFile).status, 0);
  assert.equal(run(steps, { ...withFile, placeholders: ["gamma"] }).status, 0);
});

test("a listed placeholder that already has files fails, so its line must be removed", () => {
  const steps = [{ name: "delta", globs: ["src/*.txt"], command: ok }];
  assert.notEqual(run(steps, { ...withFile, placeholders: ["delta"] }).status, 0);
});

test("every placeholder entry names a real step and gives a reason in words", () => {
  const entries = loadPlaceholders(join(root, ".github/ci-placeholders.json"));
  const names = new Set(STEPS.map((step) => step.name));
  for (const entry of entries) {
    assert.ok(names.has(entry.name), `unknown step ${entry.name}`);
    assert.match(entry.reason, /\w+ \w+/);
  }
});
