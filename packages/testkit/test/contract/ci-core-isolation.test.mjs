import { strict as assert } from "node:assert";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
// The name is joined here so this file never matches its own scan.
const CLOUD = new RegExp(["shoutory", "cloud"].join("[-/@]?"), "i");
const SOURCE = "{apps,packages}/**/*.{ts,tsx,js,mjs,cjs,json}";

test("core imports nothing from the cloud repository", () => {
  const exclude = (name) => ["node_modules", "dist", ".turbo", ".artifacts"].includes(name);
  const files = globSync(SOURCE, { cwd: root, exclude });
  assert.ok(files.length >= 1, "no file was scanned");
  const offenders = files.filter((file) => CLOUD.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(offenders, []);
});
