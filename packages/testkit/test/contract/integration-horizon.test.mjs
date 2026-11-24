import { strict as assert } from "node:assert";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const files = globSync("{apps,packages}/*/test/integration/**/*.test.ts", { cwd: root });
// What reads the cluster's visibility horizon: the claim of the outbox (`outbox_claim` offers a row only once no older
// transaction runs anywhere in the cluster), the relay that calls it, and the snapshot itself.
const READS_HORIZON = /outbox_claim\(|pg_snapshot_xmin|createOutboxRelay\(/;

test("an integration file that reads the visibility horizon is named *.horizon.test.ts, so it runs alone", () => {
  const readers = files.filter((file) => READS_HORIZON.test(readFileSync(join(root, file), "utf8")));
  assert.notEqual(readers.length, 0);
  assert.deepEqual(
    readers.filter((file) => !file.endsWith(".horizon.test.ts")),
    [],
  );
});

test("the horizon files are their own integration project, run after the others one at a time, and the step runs both", () => {
  const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
  assert.match(
    config,
    /name: "integration-horizon"[\s\S]*?sequence: \{ groupOrder: 1 \}[\s\S]*?maxWorkers: 1[\s\S]*?fileParallelism: false/,
  );
  assert.match(config, /exclude: \[\.\.\.exclude, horizonFiles\]/);
  const verify = readFileSync(join(root, "scripts/verify.mjs"), "utf8");
  assert.match(verify, /vitest\("integration", "integration", "integration-horizon"\)/);
});
