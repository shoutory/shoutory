#!/usr/bin/env node
// The one check command. Runs every step over the files it expands, prints those files, and fails a step that
// ran nothing or was skipped unless the step is listed in .github/ci-placeholders.json.
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".artifacts",
  ".turbo",
  "coverage",
  "test-results",
]);

function binOf(pkg, name) {
  const dir = join(root, "node_modules", pkg);
  const { bin } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return join(dir, typeof bin === "string" ? bin : bin[name]);
}

const node = (script, ...args) => [process.execPath, script, ...args];
const sources = [
  "{apps,packages}/*/{src,test}/**/*.{ts,tsx}",
  "packages/providers/*/{src,test}/**/*.{ts,tsx}",
];
const unitTests = ["{apps,packages}/*/src/**/*.test.ts", "packages/providers/*/src/**/*.test.ts"];
const vitest = (project) => node(binOf("vitest", "vitest"), "run", "--project", project);

export const STEPS = [
  {
    name: "typecheck",
    globs: sources,
    command: node(
      binOf("typescript", "tsc"),
      "-b",
      "apps/api",
      "packages/core",
      "packages/db",
      "packages/testkit",
    ),
  },
  {
    name: "lint",
    globs: ["**/*.{mjs,ts,tsx,json}"],
    command: node(binOf("@biomejs/biome", "biome"), "check"),
    appendFiles: true,
  },
  {
    name: "knip",
    globs: ["knip.json", "package.json", "{apps,packages}/*/package.json"],
    command: node(binOf("knip", "knip")),
  },
  { name: "unit", globs: unitTests, command: vitest("unit") },
  { name: "unit-chatham", globs: unitTests, command: vitest("unit-chatham") },
  {
    name: "integration",
    globs: [
      "{apps,packages}/*/test/integration/**/*.test.ts",
      "packages/providers/*/test/integration/**/*.test.ts",
    ],
    command: vitest("integration"),
  },
  {
    name: "contract",
    globs: [
      "{apps,packages}/*/test/contract/**/*.test.ts",
      "packages/providers/*/test/contract/**/*.test.ts",
    ],
    command: vitest("contract"),
  },
  {
    name: "testkit-contract",
    globs: ["packages/testkit/test/contract/*.test.mjs", "scripts/*.test.mjs"],
    command: [process.execPath, "--test"],
    appendFiles: true,
  },
  {
    name: "invariants",
    globs: ["packages/testkit/test/invariants/*.test.mjs"],
    command: [process.execPath, "--test"],
    appendFiles: true,
  },
  {
    name: "guard",
    globs: ["scripts/check-no-planning-paths.mjs"],
    command: node("scripts/check-no-planning-paths.mjs"),
  },
];

export function loadPlaceholders(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function expand(globs, cwd) {
  const exclude = (name) => SKIPPED_DIRS.has(name);
  const files = globs.flatMap((pattern) => globSync(pattern, { cwd, exclude }));
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
}

// Returns the failure reason of a step before it runs, or null when it may run.
function refusal(step, files, isPlaceholder) {
  if (step.skip) return isPlaceholder ? null : `skipped (${step.skip})`;
  if (isPlaceholder)
    return files.length > 0 ? "listed as a placeholder but already has files; remove its line" : null;
  return files.length === 0 ? "ran nothing" : null;
}

function execute(step, files, cwd) {
  const [bin, ...args] = step.command;
  const run = spawnSync(bin, step.appendFiles ? [...args, ...files] : args, { cwd, stdio: "inherit" });
  return run.status === 0 ? null : `command exited with ${run.status ?? run.signal}`;
}

function runStep(step, { cwd, placeholders, log }) {
  const isPlaceholder = placeholders.includes(step.name);
  const files = expand(step.globs ?? [], cwd);
  log(`== ${step.name}: ${files.length} file(s)`);
  for (const file of files) log(`   ${file}`);
  const failure = refusal(step, files, isPlaceholder);
  if (failure) {
    log(`-- ${step.name}: FAIL, ${failure}`);
    return false;
  }
  if (isPlaceholder) {
    log(`-- ${step.name}: not applicable yet (placeholder)`);
    return true;
  }
  const error = execute(step, files, cwd);
  log(`-- ${step.name}: ${error ? `FAIL, ${error}` : "pass"}`);
  return error === null;
}

export function runSteps(steps, { cwd = root, placeholders = [], log = console.log } = {}) {
  const results = steps.map((step) => runStep(step, { cwd, placeholders, log }));
  return results.every(Boolean) ? 0 : 1;
}

if (import.meta.main) {
  const names = loadPlaceholders(join(root, ".github/ci-placeholders.json")).map((entry) => entry.name);
  process.exit(runSteps(STEPS, { placeholders: names }));
}
