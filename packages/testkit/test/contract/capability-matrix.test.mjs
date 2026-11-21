import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const script = join(root, "scripts/gen-capability-matrix.mjs");
const dir = mkdtempSync(join(tmpdir(), "capability-matrix-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const manifests = [
  {
    id: "fixture",
    displayName: "Fixture Network",
    lifecycle: "beta",
    readBackMode: "A",
    capabilities: ["text", "edit"],
  },
];

function run(mode, file, list) {
  const source = join(dir, "manifests.json");
  writeFileSync(source, JSON.stringify(list));
  return spawnSync(process.execPath, [script, ...mode, "--manifests", source, "--out", file], {
    encoding: "utf8",
  });
}

test("the generator writes the matrix, and --check accepts the file it just wrote", () => {
  const file = join(dir, "fresh.md");
  assert.equal(run([], file, manifests).status, 0);
  assert.match(readFileSync(file, "utf8"), /fixture/);
  assert.equal(run(["--check"], file, manifests).status, 0);
});

test("--check fails on a stale file and leaves it untouched", () => {
  const file = join(dir, "stale.md");
  run([], file, manifests);
  const stale = `${readFileSync(file, "utf8")}\nhand edit\n`;
  writeFileSync(file, stale);
  const result = run(["--check"], file, manifests);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(file, "utf8"), stale);
});

test("--check fails when the manifests changed since the file was written", () => {
  const file = join(dir, "changed.md");
  assert.equal(run([], file, manifests).status, 0);
  const changed = [{ ...manifests[0], capabilities: ["text"] }];
  assert.notEqual(run(["--check"], file, changed).status, 0);
});

test("--check fails on a missing file, and an empty registry still has a fresh form", () => {
  const file = join(dir, "missing.md");
  assert.notEqual(run(["--check"], file, []).status, 0);
  assert.equal(run([], file, []).status, 0);
  assert.equal(run(["--check"], file, []).status, 0);
});
