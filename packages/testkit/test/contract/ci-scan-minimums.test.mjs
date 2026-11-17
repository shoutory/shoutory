import { strict as assert } from "node:assert";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCANS = [
  "packages/testkit/test/invariants/*.test.mjs",
  "packages/testkit/test/contract/ci-advisory-locks.test.mjs",
];
// A scan over zero files passes for the wrong reason, so every scan must state how many inputs it needs.
const MINIMUM = /\.length\s*>=\s*[1-9]\d*/;

const scanFiles = () => SCANS.flatMap((pattern) => globSync(pattern, { cwd: root }));

test("every scan invariant asserts a minimum input count", () => {
  const files = scanFiles();
  assert.ok(files.length >= 2, "fewer than 2 scan tests were found");
  const without = files.filter((file) => !MINIMUM.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(without, []);
});

for (const [title, source] of [
  ["a scan that only compares offenders to an empty list", "assert.deepEqual(offenders(root), []);"],
  ["a scan whose minimum is zero", "assert.ok(files.length >= 0);"],
]) {
  test(`the check rejects ${title}`, () => {
    assert.equal(MINIMUM.test(source), false);
  });
}
