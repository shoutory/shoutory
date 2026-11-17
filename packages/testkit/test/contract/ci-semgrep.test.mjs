import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IMAGES } from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CP = 'import * as cp from "node:child_process";\n';
const HTTPS = 'import https from "node:https";\n';

// Each case is planted in a file written at run time, outside the tree the check scans.
const PLANTS = [
  ["exec", 'import { exec } from "node:child_process";\nexec("ls");\n', "shell-child-process"],
  ["exec-sync", 'import { execSync } from "child_process";\nexecSync("ls");\n', "shell-child-process"],
  ["namespace-exec", `${CP}cp.exec("ls");\n`, "shell-child-process"],
  ["spawn-shell", `${CP}cp.spawn("ls", [], { shell: true });\n`, "shell-child-process"],
  ["exec-file-shell", `${CP}cp.execFileSync("ls", { shell: "/bin/sh" });\n`, "shell-child-process"],
  ["tls-option", `${HTTPS}https.request({ rejectUnauthorized: false });\n`, "tls-verification-disabled"],
  ["tls-env", 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\n', "tls-verification-disabled"],
  ["new-function", 'const run = new Function("a", "return a + 1");\n', "code-from-string"],
  ["vm-new-context", 'import vm from "node:vm";\nvm.runInNewContext("1 + 1");\n', "code-from-string"],
  ["vm-this-context", 'import * as vm from "node:vm";\nvm.runInThisContext("1 + 1");\n', "code-from-string"],
];

const CLEAN = `${CP}${HTTPS}cp.execFile("ls", ["-l"]);
cp.spawn("ls", [], { shell: false });
https.request({ rejectUnauthorized: true });
const match = /a(b)/.exec("ab");
`;

function plant(files) {
  const dir = mkdtempSync(join(root, ".artifacts", "semgrep-"));
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), source);
  }
  return dir;
}

function scan(dir) {
  const run = spawnSync(
    "docker",
    [
      ...["run", "--rm", "--mount", `type=bind,source=${join(root, ".semgrep")},target=/rules,readonly`],
      ...["--mount", `type=bind,source=${dir},target=/target,readonly`, IMAGES.semgrep],
      ...["semgrep", "scan", "--config", "/rules", "--error", "--metrics=off", "--disable-version-check"],
      ...["--json", "/target"],
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ok(!run.error, `docker could not start: ${run.error?.message}`);
  const results = run.stdout ? JSON.parse(run.stdout).results : [];
  return { status: run.status, results };
}

mkdirSync(join(root, ".artifacts"), { recursive: true });
const dirs = [
  plant(Object.fromEntries(PLANTS.map(([name, source]) => [`${name}.mjs`, source]))),
  plant({ "clean.mjs": CLEAN }),
];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const planted = scan(dirs[0]);

test("the scan of the planted cases exits non-zero because it found something", () => {
  assert.equal(planted.status, 1);
});

for (const [name, , rule] of PLANTS) {
  test(`semgrep rule ${rule} flags ${name}`, () => {
    const hit = planted.results.some((r) => r.path.endsWith(`${name}.mjs`) && r.check_id.endsWith(rule));
    assert.ok(hit, `no ${rule} finding in ${name}.mjs`);
  });
}

test("the scan of a clean file exits zero with no finding", () => {
  const clean = scan(dirs[1]);
  assert.deepEqual(clean.results, []);
  assert.equal(clean.status, 0);
});
