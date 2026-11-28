import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  affectedSteps,
  loadPlaceholders,
  pathsFromNul,
  RERUN_TRIGGERS,
  runSteps,
  STEPS,
} from "../../../../scripts/verify.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ok = [process.execPath, "-e", ""];
const bad = [process.execPath, "-e", "process.exit(3)"];

function run(steps, { files = {}, placeholders = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), content);
    }
    const lines = [];
    const status = runSteps(steps, { cwd, placeholders, log: (line) => lines.push(line) });
    return { status, output: lines.join("\n") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const withFile = { files: { "src/a.txt": "a" } };

test("a passing step prints the files it ran", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: ok }], withFile);
  assert.equal(status, 0);
  assert.match(output, /alpha/);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a failing step prints its files and fails the run", () => {
  const { status, output } = run([{ name: "alpha", globs: ["src/*.txt"], command: bad }], withFile);
  assert.notEqual(status, 0);
  assert.match(output, /src[\\/]a\.txt/);
});

test("a step that appends its files runs in batches, so a long list never overflows the command line", () => {
  const files = Object.fromEntries(
    Array.from({ length: 1000 }, (_, n) => [`src/${String(n).padStart(4, "0")}-${"x".repeat(90)}.txt`, "a"]),
  );
  // The command fails when one call gets more than 250 files, which a single call of all 1000 would.
  const command = [process.execPath, "-e", "process.exit(process.argv.length - 1 > 250 ? 3 : 0)"];
  const { status, output } = run([{ name: "gamma", globs: ["src/*.txt"], command, appendFiles: true }], {
    files,
  });
  assert.equal(status, 0);
  assert.match(output, /gamma: 1000 file/);
});

test("a step that ran nothing fails unless it is a listed placeholder", () => {
  const steps = [{ name: "beta", globs: ["none/*.txt"], command: ok }];
  const failing = run(steps);
  assert.notEqual(failing.status, 0);
  assert.match(failing.output, /beta/);
  assert.equal(run(steps, { placeholders: ["beta"] }).status, 0);
});

test("a listed placeholder that already has files fails, so its line must be removed", () => {
  const steps = [{ name: "delta", globs: ["src/*.txt"], command: ok }];
  assert.notEqual(run(steps, { ...withFile, placeholders: ["delta"] }).status, 0);
});

test("every placeholder entry names a real step and gives a reason in words", () => {
  const entries = loadPlaceholders(join(root, ".github/ci-placeholders.json"));
  const names = new Set(STEPS.map((step) => step.name));
  for (const entry of entries) {
    assert.ok(names.has(entry.name), `unknown step ${entry.name}`);
    assert.match(entry.reason, /\w+ \w+/);
  }
});

const FEATURE = "refs/heads/feature";
const selected = (changed, options = {}) =>
  affectedSteps(STEPS, { changed, ref: FEATURE, ...options }).map((step) => step.name);
const ALWAYS = ["unit", "lint", "typecheck", "gitleaks"];

const SELECTIONS = [
  ["docs only", ["docs/guide/x.md"], {}, ["unit", ...ALWAYS], ["e2e", "image-smoke"]],
  ["a web source", ["apps/web/src/a.tsx"], {}, ["e2e", "image-smoke"], []],
  // The api, db, core and provider packages leave the browser and image steps to the full run on main.
  ["an api source", ["apps/api/src/a.ts"], {}, ALWAYS, ["e2e", "image-smoke"]],
  ["a core package", ["packages/core/src/a.ts"], {}, ALWAYS, ["e2e", "image-smoke"]],
  ["a db migration", ["packages/db/migrations/0018_x.sql"], {}, ["unit", ...ALWAYS], ["e2e", "image-smoke"]],
  ["a spec only", ["e2e/specs/a.spec.ts"], {}, ["e2e"], ["image-smoke"]],
  ["the Dockerfile", ["docker/Dockerfile"], {}, ["e2e", "image-smoke"], []],
  // A move lists the old path and the new one (`--no-renames`), so leaving a watched folder still selects the steps.
  [
    "a file moved out of a watched folder",
    ["apps/web/src/a.tsx", "packages/testkit/src/a.tsx"],
    {},
    ["e2e", "image-smoke"],
    [],
  ],
  ["the lockfile", ["pnpm-lock.yaml"], {}, ["e2e", "image-smoke"], []],
  ["the root tsconfig", ["tsconfig.json"], {}, ["e2e", "image-smoke"], []],
  ["the base tsconfig", ["tsconfig.base.json"], {}, ["e2e", "image-smoke"], []],
  ["the docker ignore file", [".dockerignore"], {}, ["e2e", "image-smoke"], []],
  ["the image smoke script", ["scripts/image-smoke.mjs"], {}, ["e2e", "image-smoke"], []],
  ["a test-kit source", ["packages/testkit/src/a.ts"], {}, ALWAYS, ["e2e", "image-smoke"]],
  ["the check command", ["scripts/verify.mjs"], {}, STEPS.map((step) => step.name), []],
  ["the workflow", [".github/workflows/ci.yml"], {}, STEPS.map((step) => step.name), []],
  ["docs only with --all", ["docs/guide/x.md"], { all: true }, STEPS.map((step) => step.name), []],
  ["docs only on main", ["docs/guide/x.md"], { ref: "refs/heads/main" }, STEPS.map((step) => step.name), []],
  [
    "docs only on a tag",
    ["docs/guide/x.md"],
    { ref: "refs/tags/v1.0.0" },
    STEPS.map((step) => step.name),
    [],
  ],
  ["an unknown change set", undefined, {}, STEPS.map((step) => step.name), []],
];

test("each changed path selects exactly its steps", () => {
  for (const [label, changed, options, included, excluded] of SELECTIONS) {
    const names = selected(changed, options);
    for (const name of included) assert.ok(names.includes(name), `${label}: ${name} must run`);
    for (const name of excluded) assert.ok(!names.includes(name), `${label}: ${name} must not run`);
  }
});

const integrationOf = (changed, options) =>
  affectedSteps(STEPS, { changed, base: "base-sha-1", ref: FEATURE, ...options }).find(
    (step) => step.name === "integration",
  ).command;

test("a branch runs only the integration files that import a changed file; main, --all and the check command run all", () => {
  for (const [label, changed, options, narrowed] of [
    ["an api source on a branch", ["apps/api/src/a.ts"], {}, true],
    ["an api source on main", ["apps/api/src/a.ts"], { ref: "refs/heads/main" }, false],
    ["an api source with --all", ["apps/api/src/a.ts"], { all: true }, false],
    ["the check command on a branch", ["scripts/verify.mjs"], {}, false],
    ["no known merge base", ["apps/api/src/a.ts"], { base: undefined }, false],
  ]) {
    const command = integrationOf(changed, options).join(" ");
    assert.equal(command.includes("--changed base-sha-1 --passWithNoTests"), narrowed, label);
  }
});

// Vitest's own matcher, applied as it applies the triggers: to the absolute path git reports.
const requireFromVitest = createRequire(createRequire(join(root, "package.json")).resolve("vitest"));
const triggers = requireFromVitest("picomatch")(RERUN_TRIGGERS, { dot: true });

test("a file the integration tests read without importing reruns them all on a branch", () => {
  for (const [path, reruns] of [
    ["packages/db/migrations/0046_x.sql", true],
    ["docker/postgres/init.sql", true],
    ["apps/api/test/fixtures/photo.png", true],
    ["apps/api/package.json", true],
    ["pnpm-lock.yaml", true],
    ["apps/api/src/a.ts", false],
  ]) {
    assert.equal(triggers(join(root, path).replaceAll("\\", "/")), reruns, path);
  }
});

test("every workspace the Dockerfile COPYs still gets the browser and image steps on main", () => {
  const dockerfile = readFileSync(join(root, "docker/Dockerfile"), "utf8");
  const copied = [...dockerfile.matchAll(/^COPY --from=build \/app\/((?:apps|packages)\/[^/\s]+)\//gm)].map(
    (match) => match[1],
  );
  assert.ok(copied.length > 0, "no COPY of a workspace was found");
  for (const dir of new Set(copied)) {
    const names = selected([`${dir}/src/a.ts`], { ref: "refs/heads/main" });
    assert.ok(names.includes("e2e") && names.includes("image-smoke"), `${dir}: main must run both`);
  }
});

test("git's NUL-separated path lists keep a name with a space or a newline whole", () => {
  const diff = "docs/a b.md\0e2e/specs/x\ny.spec.ts\0";
  const added = "apps/web/src/new.tsx\0";
  assert.deepEqual(pathsFromNul(diff, added), [
    "docs/a b.md",
    "e2e/specs/x\ny.spec.ts",
    "apps/web/src/new.tsx",
  ]);
});
