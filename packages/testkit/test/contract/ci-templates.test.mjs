import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("pull_request_template.md has exactly the six sections", () => {
  const text = readFileSync(join(root, ".github/pull_request_template.md"), "utf8");
  const headings = text.split(/\r?\n/).filter((line) => line.startsWith("#"));
  assert.deepEqual(headings, [
    "## Summary",
    "## Why",
    "## How tested",
    "## Breaking change",
    "## AI assistance",
    "## CLA",
  ]);
});
