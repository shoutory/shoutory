import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "");

test("SECURITY.md names a contact and README and CONTRIBUTING link it", () => {
  assert.match(read("SECURITY.md"), /security@shoutory\.com/);
  assert.match(read("README.md"), /\(SECURITY\.md\)/);
  assert.match(read("CONTRIBUTING.md"), /\(SECURITY\.md\)/);
});

test("CODEOWNERS is exactly the one owner line", () => {
  assert.equal(read(".github/CODEOWNERS").trim(), "* @Moshaban09");
});
