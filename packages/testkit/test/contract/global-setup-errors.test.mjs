import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// With the module cache on, Vitest 5.0.5 hands Vite a Buffer for cached modules, and formatting an error thrown from
// the TypeScript global setup then crashes with "code.charCodeAt is not a function", hiding the real error.
// The cache is only used from the second run on, so the run is made twice.
function integrationRun() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("SHOUTORY_")),
  );
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--project", "integration"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return `${result.stdout}\n${result.stderr}`;
}

test("a failing global setup prints its own error, even on a warm module cache", () => {
  integrationRun();
  const output = integrationRun();
  assert.match(output, /SHOUTORY_DATABASE_URL_OWNER is not set/);
  assert.doesNotMatch(output, /charCodeAt/);
});
