import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (file) => readFileSync(join(root, file), "utf8");
const lines = (file) => read(file).split(/\r?\n/);

const REQUIRED_FILES = [
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".npmrc",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "biome.json",
  "turbo.json",
  "knip.json",
  "vitest.config.ts",
  "tsconfig.base.json",
  "e2e/playwright.config.ts",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  ".github/CODEOWNERS",
  "docs/dependencies.md",
];

test("every required root file exists", () => {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(root, file)));
  assert.deepEqual(missing, []);
});

const SCRIPTS = [
  "typecheck",
  "lint",
  "test",
  "test:unit",
  "test:integration",
  "test:contract",
  "test:focus",
  "e2e",
  "build",
  "knip",
  "verify",
];

test("package.json pins the toolchain and defines the script set", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.packageManager, "pnpm@12.17.0");
  assert.equal(pkg.engines.node, "26.13.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "AGPL-3.0-only");
  for (const name of SCRIPTS) assert.ok(pkg.scripts?.[name], `script ${name}`);
  assert.equal(pkg.scripts.verify, "node scripts/verify.mjs");
});

const PINS = {
  typescript: "7.0.2",
  vitest: "5.0.5",
  vite: "8.3.5",
  "@biomejs/biome": "2.6.4",
  turbo: "2.11.10",
  knip: "6.44.1",
  "@playwright/test": "1.64.1",
  "@types/node": "26.6.6",
};

test("root devDependencies are exact pins from the register", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(pkg.devDependencies, PINS);
});

test(".nvmrc names the exact Node patch", () => {
  assert.equal(read(".nvmrc").trim(), "26.13.0");
});

const WORKSPACE_SETTINGS = [
  "minimumReleaseAge: 20160",
  "minimumReleaseAgeExclude: []",
  "strictDepBuilds: true",
  "trustPolicy: no-downgrade",
  "blockExoticSubdeps: true",
  "saveExact: true",
  "strictPeerDependencies: true",
  "allowBuilds:",
  "- apps/*",
  "- packages/*",
  "- packages/providers/*",
];

for (const setting of WORKSPACE_SETTINGS) {
  test(`pnpm-workspace.yaml carries "${setting}"`, () => {
    assert.ok(lines("pnpm-workspace.yaml").some((line) => line.trim() === setting));
  });
}

test(".npmrc holds the registry line only", () => {
  const active = lines(".npmrc").filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.deepEqual(active, ["registry=https://registry.npmjs.org/"]);
});

test("the AGPL text is the verbatim one", () => {
  const bytes = readFileSync(join(root, "LICENSE"));
  assert.match(bytes.toString("utf8").split(/\r?\n/)[0], /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "5b557a1b2818690b69399e584fec5edfce6673223479b9b6371d35474c13378e",
  );
});

for (const dir of ["apps/api", "packages/core", "packages/db", "packages/testkit"]) {
  test(`${dir} is a manifest-only workspace named @shoutory/<directory>`, () => {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    assert.equal(pkg.name, `@shoutory/${dir.split("/")[1]}`);
    assert.ok(existsSync(join(root, dir, "tsconfig.json")));
  });
}
