#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
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
const workflowFiles = [".github/workflows/*.{yml,yaml}", ".github/actions/**/action.{yml,yaml}"];
const unitTests = [
  "{apps,packages}/*/src/**/*.test.ts",
  "packages/providers/*/src/**/*.test.ts",
  "apps/web/src/**/*.test.tsx",
];
// The JSON report lets a skipped or todo test fail the step.
const vitestReport = (step) => `.artifacts/vitest-${step}.json`;
const vitest = (step, ...projects) => ({
  command: node(
    binOf("vitest", "vitest"),
    "run",
    ...projects.flatMap((project) => ["--project", project]),
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${vitestReport(step)}`,
  ),
  skips: { json: vitestReport(step) },
});
const nodeTests = { command: [process.execPath, "--test", "--test-reporter=tap"], skips: "node-test" };

// The workflow pulls the same pinned references, so a local run and a CI run are the same tool.
export const IMAGES = {
  semgrep: "semgrep/semgrep:1.183.0@sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0",
  gitleaks:
    "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
  actionlint:
    "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667",
  zizmor:
    "ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d",
  "osv-scanner":
    "ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0",
};

// Git needs the read-only mount trusted to read the history.
const container = (name, args, options = []) => [
  "docker",
  "run",
  "--rm",
  "--mount",
  `type=bind,source=${root},target=/src,readonly`,
  "-w",
  "/src",
  ...options,
  IMAGES[name],
  ...args,
];
const trustMount = [
  "-e",
  "GIT_CONFIG_COUNT=1",
  "-e",
  "GIT_CONFIG_KEY_0=safe.directory",
  "-e",
  "GIT_CONFIG_VALUE_0=/src",
];
const gitleaksRange = [`--log-opts=${process.env.GITLEAKS_LOG_OPTS || "HEAD"}`];
const pnpm = (...args) => {
  const exe = process.env.npm_execpath ?? "pnpm";
  return /\.c?js$/.test(exe) ? [process.execPath, exe, ...args] : [exe, ...args];
};
const gitMessage = () =>
  process.env.PR_TITLE ||
  spawnSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" }).stdout;

// A change in the api, db, core or provider packages leaves the image and browser steps to the full run on main: they
// take minutes and the unit, integration and contract steps already cover those packages.
const IMAGE_INPUTS = [
  "apps/web/**",
  "docker/**",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".nvmrc",
  "tsconfig*.json",
  ".dockerignore",
  "scripts/image-smoke.mjs",
];

export const STEPS = [
  {
    name: "typecheck",
    globs: sources,
    // The root tsconfig.json lists the projects that have sources, so an empty package never fails the build.
    command: node(binOf("typescript", "tsc"), "-b"),
  },
  {
    name: "lint",
    globs: ["**/*.{mjs,js,ts,tsx,css,json,grit}"],
    command: node(binOf("@biomejs/biome", "biome"), "check"),
    appendFiles: true,
  },
  {
    name: "knip",
    globs: ["knip.json", "package.json", "{apps,packages}/*/package.json"],
    command: node(binOf("knip", "knip")),
  },
  { name: "unit", globs: unitTests, ...vitest("unit", "unit", "web") },
  { name: "unit-chatham", globs: unitTests, ...vitest("unit-chatham", "unit-chatham", "web-chatham") },
  {
    name: "integration",
    globs: [
      "{apps,packages}/*/test/integration/**/*.test.ts",
      "packages/providers/*/test/integration/**/*.test.ts",
    ],
    env: [
      "SHOUTORY_TEST_ADMIN_URL",
      "SHOUTORY_TEST_S3_URL",
      ...["OWNER", "APP", "WORKER", "AUTH", "READONLY"].map((role) => `SHOUTORY_DATABASE_URL_${role}`),
    ],
    narrow: true,
    ...vitest("integration", "integration", "integration-horizon"),
  },
  {
    name: "contract",
    globs: [
      "{apps,packages}/*/test/contract/**/*.test.ts",
      "packages/providers/*/test/contract/**/*.test.ts",
    ],
    ...vitest("contract", "contract"),
  },
  {
    name: "testkit-contract",
    globs: ["packages/testkit/test/contract/*.test.mjs", "scripts/*.test.mjs"],
    ...nodeTests,
    appendFiles: true,
  },
  {
    name: "invariants",
    globs: ["packages/testkit/test/invariants/*.test.mjs"],
    ...nodeTests,
    appendFiles: true,
  },
  {
    name: "guard",
    globs: ["scripts/check-no-planning-paths.mjs"],
    command: node("scripts/check-no-planning-paths.mjs"),
  },
  {
    // The typecheck step (or `tsc -b`) builds the registry the generator reads.
    name: "capability-matrix",
    globs: [
      "packages/provider-registry/src/index.ts",
      "packages/providers/*/src/manifest.ts",
      "packages/provider-sdk/src/manifest/manifest.ts",
      "docs/providers/capability-matrix.md",
    ],
    command: node("scripts/gen-capability-matrix.mjs", "--check"),
  },
  // The entry files that make a placeholder step live; other files that arrive earlier must not break it.
  { name: "build", globs: ["apps/api/src/main.ts"], command: pnpm("run", "build") },
  {
    name: "e2e",
    docker: true,
    globs: ["e2e/**/*.spec.ts"],
    watch: [...IMAGE_INPUTS, "e2e/**"],
    command: pnpm("run", "e2e"),
  },
  {
    name: "image-smoke",
    docker: true,
    globs: ["docker/Dockerfile*"],
    watch: IMAGE_INPUTS,
    command: pnpm("run", "image-smoke"),
  },
  { name: "upgrade", globs: ["e2e/upgrade/**"], command: pnpm("run", "upgrade") },
  {
    name: "semgrep",
    docker: true,
    globs: ["**/*.{js,mjs,cjs,ts,tsx}"],
    command: container("semgrep", [
      "semgrep",
      "scan",
      "--config",
      ".semgrep",
      "--error",
      "--metrics=off",
      "--disable-version-check",
      "--exclude",
      "node_modules",
      "--exclude",
      ".artifacts",
      "--exclude",
      "dist",
      ".",
    ]),
  },
  {
    name: "gitleaks",
    docker: true,
    globs: ["**/*"],
    command: container(
      "gitleaks",
      ["git", "--redact", "--no-banner", "--exit-code", "1", ...gitleaksRange, "."],
      trustMount,
    ),
  },
  {
    name: "osv-scanner",
    docker: true,
    globs: ["pnpm-lock.yaml"],
    command: container("osv-scanner", ["scan", "source", "--lockfile", "pnpm-lock.yaml"]),
  },
  {
    name: "actionlint",
    docker: true,
    globs: [workflowFiles[0]],
    command: container("actionlint", ["-color"]),
    appendFiles: true,
  },
  {
    name: "zizmor",
    docker: true,
    globs: workflowFiles,
    command: container("zizmor", ["--pedantic", "--offline", "--no-progress"]),
    appendFiles: true,
  },
  { name: "audit", globs: ["pnpm-lock.yaml"], command: pnpm("audit", "--audit-level=high") },
  {
    name: "supply-chain",
    globs: ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "{apps,packages}/*/package.json"],
    command: node("packages/testkit/scripts/supply-chain.mjs"),
  },
  {
    name: "commit-message",
    globs: ["commitlint.config.mjs"],
    command: node(binOf("@commitlint/cli", "commitlint"), "--config", "commitlint.config.mjs"),
    input: gitMessage,
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

function refusal(step, files, isPlaceholder) {
  if (isPlaceholder)
    return files.length > 0 ? "listed as a placeholder but already has files; remove its line" : null;
  return files.length === 0 ? "ran nothing" : null;
}

const dockerRuns = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

function skippedTests(step, stdout, cwd) {
  if (step.skips === "node-test") {
    const count = (key) => {
      const found = [...stdout.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, "gm"))];
      return found.length === 0 ? Number.NaN : found.reduce((sum, match) => sum + Number(match[1]), 0);
    };
    return count("skipped") + count("todo");
  }
  const file = join(cwd, step.skips.json);
  if (!existsSync(file)) return Number.NaN;
  const report = JSON.parse(readFileSync(file, "utf8"));
  return report.numPendingTests + report.numTodoTests;
}

// Vitest cannot print an error thrown by the TypeScript global setup (a vite module-runner crash hides it), so a
// missing variable is named here instead of surfacing as "No test files found".
function missingEnv(step) {
  const name = (step.env ?? []).find((variable) => !process.env[variable]);
  return name
    ? `${name} is not set; this step needs the local database and the S3 simulator of the README`
    : null;
}

// Windows refuses a command line of more than 32767 characters, so the files go to the command in batches under it.
const BATCH_CHARS = 20_000;
function fileBatches(files) {
  const batches = [[]];
  let size = 0;
  for (const file of files) {
    if (size + file.length + 1 > BATCH_CHARS && batches.at(-1).length > 0) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1).push(file);
    size += file.length + 1;
  }
  return batches;
}

// Runs the command once per batch of files; the first failure ends it. Returns the failure text or the printed output.
function runBatches(step, files, cwd) {
  const [bin, ...args] = step.command;
  const input = step.input?.();
  const capture = step.skips === "node-test";
  const stdio = [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"];
  const batches = step.appendFiles ? fileBatches(files) : [[]];
  let stdout = "";
  for (const batch of batches) {
    const run = spawnSync(bin, [...args, ...batch], {
      cwd,
      stdio,
      input,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const printed = run.stdout ?? "";
    if (capture) process.stdout.write(printed);
    if (run.error) return { error: `command could not start: ${run.error.message}` };
    if (run.status !== 0) return { error: `command exited with ${run.status ?? run.signal}` };
    stdout += printed;
  }
  return { stdout };
}

function execute(step, files, cwd) {
  if (step.docker && !dockerRuns()) return "Docker is not running; start it, this step runs a container";
  const unset = missingEnv(step);
  if (unset) return unset;
  if (step.skips?.json) rmSync(join(cwd, step.skips.json), { force: true }); // a stale report proves nothing
  const { error, stdout } = runBatches(step, files, cwd);
  if (error) return error;
  if (!step.skips) return null;
  const skipped = skippedTests(step, stdout, cwd);
  if (Number.isNaN(skipped)) return "the test run printed no skip count";
  return skipped === 0 ? null : `${skipped} skipped or todo test(s) reported; a skipped test is a failure`;
}

function runStep(step, { cwd, placeholders, reasons, outputFile, log }) {
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
    log(`-- ${step.name}: not applicable yet: ${reasons[step.name] ?? "listed as a placeholder"}`);
    if (outputFile) appendFileSync(outputFile, "placeholder=true\n");
    return true;
  }
  const error = execute(step, files, cwd);
  log(`-- ${step.name}: ${error ? `FAIL, ${error}` : "pass"}`);
  return error === null;
}

export function runSteps(
  steps,
  { cwd = root, placeholders = [], reasons = {}, outputFile, log = console.log } = {},
) {
  const results = steps.map((step) => runStep(step, { cwd, placeholders, reasons, outputFile, log }));
  return results.every(Boolean) ? 0 : 1;
}

// A change to the check command or the workflow can affect any step, so it selects them all.
const CHECK_FILES = ["scripts/verify.mjs", ".github/workflows/ci.yml"];

// A narrowed step runs only the test files that import a changed file, directly or through other modules
// (https://vitest.dev/guide/recipes/affected-tests, read 2026-11-25). A change to a file the tests read without
// importing it reruns the whole suite (https://vitest.dev/config/forcereruntriggers, read 2026-11-25). Vitest matches
// these against absolute paths, so each pattern starts with `**/`; the first three are its defaults.
export const RERUN_TRIGGERS = [
  "**/package.json",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/packages/db/migrations/*.sql",
  "**/docker/postgres/init.sql",
  "**/test/fixtures/**",
  "**/pnpm-lock.yaml",
  "**/tsconfig*.json",
];
const narrowed = (step, base) => ({
  ...step,
  command: [...step.command, "--changed", base, "--passWithNoTests"],
});

export function affectedSteps(steps, { changed, base, all = false, ref = process.env.GITHUB_REF } = {}) {
  const full =
    all ||
    changed === undefined ||
    ref === "refs/heads/main" ||
    ref?.startsWith("refs/tags/") ||
    changed.some((path) => CHECK_FILES.includes(path));
  if (full) return steps;
  return steps
    .filter(
      (step) => !step.watch || changed.some((path) => step.watch.some((glob) => matchesGlob(path, glob))),
    )
    .map((step) => (step.narrow && base ? narrowed(step, base) : step));
}

function changedPaths() {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const merge = git("merge-base", "origin/main", "HEAD");
  if (merge.status !== 0) return {};
  const base = merge.stdout.trim();
  // `--no-renames` lists a move as the old path and the new one, so leaving a watched folder still counts.
  const diff = git("diff", "--name-only", "--no-renames", "-z", base);
  const added = git("ls-files", "--others", "--exclude-standard", "-z");
  if (diff.status !== 0 || added.status !== 0) return {};
  return { changed: pathsFromNul(diff.stdout, added.stdout), base };
}

// NUL-separated, so a name with a space, a quote or a newline stays one path.
export function pathsFromNul(...outputs) {
  return outputs.flatMap((output) => output.split("\0")).filter(Boolean);
}

function selectSteps(argv) {
  const at = argv.indexOf("--only");
  if (at >= 0) {
    const chosen = STEPS.filter((step) => step.name === argv[at + 1]);
    if (chosen.length === 0)
      throw new Error(`unknown step ${argv[at + 1]}; steps: ${STEPS.map((s) => s.name)}`);
    return chosen;
  }
  const all = argv.includes("--all");
  const { changed, base } = all ? {} : changedPaths();
  const chosen = affectedSteps(STEPS, { changed, base, all });
  if (!all && changed === undefined && chosen === STEPS)
    console.log("== origin/main is not known here: running every step");
  const names = new Set(chosen.map((step) => step.name));
  const skipped = STEPS.filter((step) => !names.has(step.name)).map((step) => step.name);
  for (const step of chosen.filter((each) => !STEPS.includes(each)))
    console.log(`== ${step.name}: only the test files that import a changed file (since ${base})`);
  if (skipped.length > 0) console.log(`== skipped, no watched path changed: ${skipped.join(", ")}`);
  return chosen;
}

if (import.meta.main) {
  const entries = loadPlaceholders(join(root, ".github/ci-placeholders.json"));
  const reasons = Object.fromEntries(entries.map((entry) => [entry.name, entry.reason]));
  const placeholders = entries.map((entry) => entry.name);
  const outputFile = process.env.GITHUB_OUTPUT;
  process.exit(runSteps(selectSteps(process.argv.slice(2)), { placeholders, reasons, outputFile }));
}
