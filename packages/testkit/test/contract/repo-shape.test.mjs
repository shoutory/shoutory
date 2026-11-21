import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync } from "node:fs";
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
  "@axe-core/playwright": "4.14.0",
  "@better-auth/utils": "0.5.1",
  "@biomejs/biome": "2.6.4",
  turbo: "2.11.10",
  knip: "6.44.1",
  "@playwright/test": "1.64.1",
  "@stryker-mutator/core": "10.1.1",
  "@stryker-mutator/vitest-runner": "10.1.1",
  "@types/node": "26.6.6",
  "@commitlint/cli": "21.2.4",
  "@commitlint/config-conventional": "21.2.4",
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
    "e0eedba615d5cd1b986afb6c5b3a4b1ae33713e7e9dc74d19daec5e3221f9d2e",
  );
});

test("the test kit is not part of the image", () => {
  // Every stage after the build stage ends up in the image; the build stage may name anything.
  const runtime = read("docker/Dockerfile")
    .split(/^FROM .* AS build$/m)[1]
    .split(/^FROM /m)
    .slice(1)
    .join("\n");
  assert.ok(
    runtime.includes("COPY --from=build"),
    "the Dockerfile has no runtime stage after the build stage",
  );
  assert.doesNotMatch(runtime, /testkit/);
  // Copying the whole packages folder would carry the test kit in without naming it.
  assert.doesNotMatch(runtime, /^COPY\s+--from=\S+\s+\/app\/packages\/?\s/m);
  const api = JSON.parse(read("apps/api/package.json"));
  const named = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
    Object.keys(api[field] ?? {}),
  );
  assert.deepEqual(
    named.filter((name) => name.includes("testkit")),
    [],
  );
  const sources = globSync("apps/api/src/**/*.ts", { cwd: root }).filter(
    (file) => !file.endsWith(".test.ts"),
  );
  assert.ok(sources.length > 0, "no apps/api source files were found");
  assert.deepEqual(
    sources.filter((file) => /testkit/.test(read(file))),
    [],
  );
});

for (const dir of ["apps/api", "packages/core", "packages/db", "packages/provider-sdk", "packages/testkit"]) {
  test(`${dir} is a manifest-only workspace named @shoutory/<directory>`, () => {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    assert.equal(pkg.name, `@shoutory/${dir.split("/")[1]}`);
    assert.ok(existsSync(join(root, dir, "tsconfig.json")));
  });
}
