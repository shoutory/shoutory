import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the restore project exists only when SHOUTORY_E2E_RESTORE is true, follows the journey, and the founder project ignores the spec", () => {
  const config = read("e2e/playwright.config.ts");
  assert.match(
    config,
    /process\.env\.SHOUTORY_E2E_RESTORE === "true"/,
    "the project is not gated by the variable",
  );
  const project = /name: "restore",[^}]*?dependencies: \["journey"\]/s;
  assert.match(config, project, "no restore project that depends on the journey only");
  const spec = /const RESTORE = "restore-drill\.spec\.ts";/;
  assert.match(config, spec, "the drill's spec file is not named once");
  const founder = /name: "founder",\s*testIgnore: \[[^\]]*RESTORE[^\]]*\]/s;
  assert.match(config, founder, "the founder project would run the drill with the other specs");
  const failsFast = /RESTORE_RUN && ![^;]*\)\s*\{?\s*throw new Error\([^;]*--project restore/s;
  assert.match(
    config,
    failsFast,
    "a run with the switch set but another project selected does not stop with an error",
  );
  assert.match(
    config,
    /projects: RESTORE_RUN[\s\S]*:\s*FULL,\s*\}\);/,
    "the default projects are not one list",
  );
});

test("every command the drill runs appears verbatim in the guide, and the guide states the same-id limit of secrets check", () => {
  const commands = JSON.parse(read("e2e/support/restore-commands.json"));
  const guide = read("docs/self-host/backup-restore.md");
  for (const [name, command] of Object.entries(commands)) {
    assert.ok(guide.includes(command), `the guide lacks the ${name} command: ${command}`);
  }
  assert.match(guide, /same key id/i, "the guide does not say a wrong key under the same id passes");
});
