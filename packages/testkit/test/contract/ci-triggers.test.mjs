import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { on } = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));

test("ci.yml runs on pull requests, on push to main and on v tags, and is not reusable", () => {
  assert.ok("pull_request" in on);
  assert.deepEqual(on.push, { branches: ["main"], tags: ["v*"] });
  assert.equal("workflow_call" in on, false);
});
