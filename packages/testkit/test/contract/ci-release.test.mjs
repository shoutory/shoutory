import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

test("the release tool runs from main or by hand, starts at the root version and tags without a component", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
  assert.deepEqual(workflow.on, { push: { branches: ["main"] }, workflow_dispatch: null });
  const config = json("release-please-config.json");
  assert.equal(config["release-type"], "node");
  assert.equal(config["include-component-in-tag"], false);
  assert.deepEqual(json(".release-please-manifest.json"), { ".": json("package.json").version });
});
